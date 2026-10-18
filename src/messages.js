// Agent to agent mail.
//   send    -> a row per message; recipients are woken through LISTEN/NOTIFY
//   inbox   -> claims pending mail (at-least-once; unacked mail is offered again after 2 minutes)
//   ask     -> send a request and wait for the reply in the same thread
// Backpressure keeps an offline agent from coming back to a flood: limited pending mail per
// recipient and per sender, collapse_key replaces a pending update instead of adding another,
// and every message expires.
import crypto from 'node:crypto';
import { q, one, all, tx, notifyInbox, waitForMail } from './db.js';
import { fail } from './http.js';
import { resolve, driverId } from './agents.js';

const MAX_BODY = 32 * 1024, MAX_DATA = 64 * 1024;
const MAX_PENDING_TO = 200, MAX_PENDING_PAIR = 25;
const REDELIVER = `interval '2 minutes'`;
const KINDS = ['message', 'request', 'reply', 'event'];

// per-sender rate limit (in memory: one machine)
const buckets = new Map();
function rateLimit(id, perMinute = 120) {
  const now = Date.now(), b = buckets.get(id) || { n: 0, reset: now + 60e3 };
  if (b.reset < now) { b.n = 0; b.reset = now + 60e3; }
  b.n++; buckets.set(id, b);
  if (b.n > perMinute) fail(429, 'Too many messages this minute. Slow down.');
}

export function messageView(m) {
  return {
    id: m.id, thread_id: m.thread_id, in_reply_to: m.in_reply_to, kind: m.kind,
    from: m.from_handle ?? null, from_platform: m.from_platform ?? null, to: m.to_handle ?? null,
    body: m.body, data: m.data ?? null, created_at: m.created_at,
  };
}
const SELECT = `select m.*, f.handle as from_handle, f.platform as from_platform, t.handle as to_handle
  from messages m left join agents f on f.id = m.from_agent join agents t on t.id = m.to_agent`;

export async function send(from, { to, body, kind = 'message', thread_id, in_reply_to, data, collapse_key, client_id, ttl_seconds }) {
  body = String(body ?? '').trim();
  if (!body) fail(400, 'body is required.');
  if (Buffer.byteLength(body) > MAX_BODY) fail(413, 'body is over 32 KB. Put long content in an artifact and send its link.');
  if (!KINDS.includes(kind)) fail(400, `kind must be one of: ${KINDS.join(', ')}.`);
  if (data !== undefined && data !== null && Buffer.byteLength(JSON.stringify(data)) > MAX_DATA) fail(413, 'data is over 64 KB.');
  if (client_id != null && !/^[A-Za-z0-9._:-]{1,100}$/.test(String(client_id))) fail(400, 'client_id must be 1 to 100 url-safe characters.');
  if (client_id) {
    const dupe = await one(`${SELECT} where m.from_agent = $1 and m.client_id = $2`, [from.id, String(client_id)]);
    if (dupe) return { message: messageView(dupe), duplicate: true };
  }
  rateLimit(from.id);

  let parent = null;
  if (in_reply_to) {
    parent = await one(`select * from messages where id::text = $1`, [String(in_reply_to)]);
    if (!parent || (parent.to_agent !== from.id && parent.from_agent !== from.id)) fail(404, 'in_reply_to is not a message you sent or received.');
  }
  const recipient = to ? await resolve(to, { from }) : parent ? await one(`select * from agents where id = $1`, [parent.from_agent === from.id ? parent.to_agent : parent.from_agent]) : fail(400, 'to is required.');
  if (!recipient || recipient.retired_at) fail(404, 'That agent is no longer connected.');
  if (recipient.id === from.id) fail(400, 'You can’t message yourself.');
  const thread = parent?.thread_id || (thread_id && /^[0-9a-f-]{36}$/.test(thread_id) ? thread_id : crypto.randomUUID());
  const ttl = Math.min(Math.max(Number(ttl_seconds) || (kind === 'event' ? 86400 : 7 * 86400), 60), 30 * 86400);
  const effectiveKind = parent && kind === 'message' ? 'reply' : kind;

  const row = await tx(async db => {
    // replace a still-pending message with the same collapse_key instead of queueing another
    if (collapse_key) {
      const prev = await db.one(`update messages set body = $4, data = $5, created_at = now(), expires_at = now() + make_interval(secs => $6), delivered_at = null
        where id = (select id from messages where from_agent = $1 and to_agent = $2 and collapse_key = $3 and acked_at is null and expires_at > now() order by created_at desc limit 1)
        returning *`, [from.id, recipient.id, String(collapse_key).slice(0, 100), body, data ?? null, ttl]);
      if (prev) return prev;
    }
    const pend = await db.one(`select count(*)::int as total, count(*) filter (where from_agent = $2)::int as mine
      from messages where to_agent = $1 and acked_at is null and expires_at > now()`, [recipient.id, from.id]);
    if (pend.total >= MAX_PENDING_TO) fail(429, `${recipient.handle} has ${pend.total} unread messages and isn’t taking more until it catches up.`, { recipient_status: 'backlogged' });
    if (pend.mine >= MAX_PENDING_PAIR) fail(429, `${recipient.handle} hasn’t picked up your last ${pend.mine} messages. Wait for it, or use collapse_key for status updates.`, { recipient_status: 'backlogged' });
    return db.one(`insert into messages (thread_id, in_reply_to, from_agent, to_agent, kind, body, data, collapse_key, client_id, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10)) returning *`,
      [thread, parent?.id || null, from.id, recipient.id, effectiveKind, body, data ?? null, collapse_key ? String(collapse_key).slice(0, 100) : null, client_id ? String(client_id) : null, ttl]);
  });
  // whoever drives an agent is who it reports back to; remotely driven sessions announce when they finish
  if (effectiveKind !== 'event') {
    await q(`update agents set reply_to = $2, meta = case when role = 'session' then meta || '{"remote": true}'::jsonb else meta end where id = $1`, [recipient.id, from.id]);
  }
  await notifyInbox(recipient.id);
  return { message: messageView({ ...row, from_handle: from.handle, from_platform: from.platform, to_handle: recipient.handle }), recipient: { handle: recipient.handle, role: recipient.role } };
}

// Claim pending mail for one or more agents (a host can collect for its sessions).
async function claim(agentIds, { limit = 20, ack = true, thread, exclude = [] } = {}) {
  const rows = await all(`
    with picked as (
      select id from messages
      where to_agent = any($1) and acked_at is null and expires_at > now()
        and (delivered_at is null or delivered_at < now() - ${REDELIVER})
        and ($4::uuid is null or thread_id = $4)
        and not (thread_id = any($5::uuid[]))
      order by created_at limit $2 for update skip locked)
    update messages m set delivered_at = now(), acked_at = case when $3 then now() else m.acked_at end
    from picked where m.id = picked.id returning m.*`, [agentIds, limit, ack, thread || null, exclude]);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  return (await all(`${SELECT} where m.id = any($1) order by m.created_at`, [ids])).map(messageView);
}

export async function inbox(agent, { wait = 0, limit = 20, ack = true, thread, exclude } = {}, signal) {
  const deadline = Date.now() + Math.min(Math.max(Number(wait) || 0, 0), 30) * 1000;
  for (;;) {
    if (!thread) agent = { ...agent, meta: (await one(`select meta from agents where id = $1`, [agent.id]))?.meta || agent.meta };
    // threads an `hpx ask` is waiting on belong to it, not to the general inbox
    const reserved = thread ? [] : [...new Set([...(exclude || []), ...((agent.meta?.asking || []).filter(t => /^[0-9a-f-]{36}$/.test(t)))])];
    const msgs = await claim([agent.id], { limit: Math.min(Math.max(Number(limit) || 20, 1), 100), ack, thread, exclude: reserved });
    if (msgs.length || Date.now() >= deadline || signal?.aborted) return msgs;
    await waitForMail([agent.id], Math.min(deadline - Date.now(), 25_000), signal);
  }
}

export async function ack(agent, ids) {
  if (!Array.isArray(ids) || !ids.length) fail(400, 'ids must be a list of message ids.');
  const r = await q(`update messages set acked_at = now() where to_agent = $1 and id::text = any($2) and acked_at is null`, [agent.id, ids.map(String).slice(0, 200)]);
  return { acked: r.rowCount };
}

export async function threadView(agent, threadId) {
  if (!/^[0-9a-f-]{36}$/.test(String(threadId))) fail(400, 'Not a thread id.');
  const isDriver = agent.id === await driverId();
  const rows = await all(`${SELECT} where m.thread_id = $1 order by m.created_at limit 200`, [threadId]);
  if (!rows.length || (!isDriver && !rows.some(r => r.from_agent === agent.id || r.to_agent === agent.id))) fail(404, 'Thread not found.');
  return rows.map(messageView);
}

// Send a request and wait (up to wait seconds, max 30 per call) for a reply in that thread.
export async function ask(from, { to, body, data, wait = 25, thread_id }) {
  const sent = await send(from, { to, body, data, kind: 'request', thread_id });
  const reply = await inbox(from, { wait: Math.min(wait, 30), limit: 1, thread: sent.message.thread_id });
  return { request: sent.message, reply: reply[0] || null,
    ...(reply[0] ? {} : { waiting: `No reply yet. Check later with GET /v1/inbox (or GET /v1/threads/${sent.message.thread_id}).` }) };
}

export async function pendingCounts(agentIds) {
  return all(`select to_agent, count(*)::int as n from messages where to_agent = any($1) and acked_at is null and expires_at > now() group by to_agent`, [agentIds]);
}
export { claim };
