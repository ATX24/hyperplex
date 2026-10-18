// The agent registry and presence.
// Presence is earned, not declared: an agent says how often it polls (poll_seconds) and is
// "online" while it keeps showing up on time. Sessions are as present as their host, until they end.
import path from 'node:path';
import { q, one, all } from './db.js';
import { fail } from './http.js';

const DEFAULT_POLL = 300;
export function presence(a, host) {
  if (a.role === 'session') {
    if (a.state === 'ended') return 'ended';
    return host ? presence(host) : 'offline';
  }
  if (!a.last_seen_at) return 'offline';
  const age = (Date.now() - new Date(a.last_seen_at)) / 1000, poll = a.poll_seconds || DEFAULT_POLL;
  return age <= poll * 2 + 30 ? 'online' : age <= poll * 10 + 300 ? 'stale' : 'offline';
}

export function view(a, { host, pending, driverId } = {}) {
  const status = presence(a, host);
  const due = a.role !== 'session' && a.last_seen_at ? new Date(new Date(a.last_seen_at).getTime() + (a.poll_seconds || DEFAULT_POLL) * 1000).toISOString() : null;
  return {
    handle: a.handle, platform: a.platform === 'pi' && a.meta?.learning ? 'pi-learning' : a.platform, role: a.id === driverId ? 'driver' : a.role, title: a.title || null,
    status, state: a.state, summary: a.summary || null, state_since: a.state_at,
    last_seen_at: a.role === 'session' ? host?.last_seen_at ?? null : a.last_seen_at, next_poll_due_at: due,
    ...(a.role === 'session' ? { host: host?.handle || null, project: a.cwd ? path.basename(a.cwd) : null, folder: a.cwd || null, session_ref: a.session_ref } : {}),
    ...(pending !== undefined ? { unread_messages: pending } : {}),
  };
}

export async function driverId() {
  return (await one(`select value #>> '{}' as id from settings where key = 'driver'`))?.id || null;
}

const COLS = `a.*, h.handle as host_handle, h.last_seen_at as host_last_seen_at, h.poll_seconds as host_poll_seconds, h.role as host_role, h.state as host_state,
  (select count(*) from messages m where m.to_agent = a.id and m.acked_at is null and m.expires_at > now())::int as pending`;
const hostOf = r => r.host_id ? { handle: r.host_handle, last_seen_at: r.host_last_seen_at, poll_seconds: r.host_poll_seconds, role: r.host_role, state: r.host_state } : null;

export async function list({ status, platform, includeEnded = false } = {}) {
  const rows = await all(`select ${COLS} from agents a left join agents h on h.id = a.host_id
    where a.retired_at is null ${platform ? 'and a.platform = $1' : ''} order by a.state_at desc`, platform ? [platform] : []);
  const drv = await driverId();
  return rows.map(r => view(r, { host: hostOf(r), pending: r.pending, driverId: drv }))
    .filter(v => (includeEnded || v.status !== 'ended') && (!status || v.status === status));
}

// Find an agent by handle, id, "driver", or a unique fragment of its handle or title.
export async function resolve(ref, { from } = {}) {
  const r = String(ref || '').trim();
  if (!r) fail(400, 'Say which agent.');
  if (r === 'driver') {
    const id = await driverId();
    if (!id) fail(404, 'No driver is connected yet.');
    return one(`select * from agents where id = $1`, [id]);
  }
  if (r === 'me' && from) return from;
  if (r === 'reply_to' && from) return from.reply_to ? one(`select * from agents where id = $1`, [from.reply_to]) : resolve('driver');
  const exact = await one(`select * from agents where (handle = $1 or id::text = $1) and retired_at is null`, [r.toLowerCase()]);
  if (exact) return exact;
  const hits = await all(`select * from agents where retired_at is null and state <> 'ended' and (handle like '%' || $1 || '%' or lower(title) like '%' || $1 || '%') order by state_at desc limit 9`, [r.toLowerCase()]);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(409, `“${r}” matches ${hits.length} agents. Use the exact handle.`, { candidates: hits.map(h => ({ handle: h.handle, platform: h.platform, title: h.title, state: h.state })) });
  fail(404, `No agent called “${r}”. List them with GET /v1/agents.`);
}

const STATES = ['working', 'idle', 'waiting', 'blocked', 'ended'];
export async function setState(agent, { state, summary, title }) {
  if (state && !STATES.includes(state)) fail(400, `state must be one of: ${STATES.join(', ')}.`);
  const changed = state && state !== agent.state;
  const row = await one(`update agents set state = coalesce($2, state), summary = coalesce($3, summary), title = coalesce($4, title),
      state_at = case when $2::text is not null and $2::text <> state then now() else state_at end
    where id = $1 returning *`, [agent.id, state || null, summary != null ? String(summary).slice(0, 2000) : null, title ? String(title).slice(0, 200) : null]);
  if (changed) await q(`insert into activity (agent_id, type, summary) values ($1, $2, $3)`, [agent.id, `state:${state}`, summary ? String(summary).slice(0, 500) : null]);
  return row;
}

// A host registers (or refreshes) one of its coding sessions as an agent of its own.
export async function ensureSession(host, { platform, session_ref, title, cwd, meta = {} }) {
  if (host.role !== 'host') fail(403, 'Only hosts register sessions.');
  const plat = String(platform || '').toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(plat)) fail(400, 'platform must be a short lowercase name like claude, codex or pi.');
  const ref = String(session_ref || '').slice(0, 200);
  if (!ref) fail(400, 'session_ref is required.');
  const existing = await one(`select * from agents where host_id = $1 and platform = $2 and session_ref = $3`, [host.id, plat, ref]);
  if (existing) {
    return one(`update agents set title = coalesce($2, title), cwd = coalesce($3, cwd), meta = meta || $4::jsonb, retired_at = null,
        state = case when state = 'ended' then 'idle' else state end where id = $1 returning *`,
      [existing.id, title ? String(title).slice(0, 200) : null, cwd || null, JSON.stringify(meta)]);
  }
  const short = ref.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'x';
  let handle = `${plat}.${host.handle}.${short}`.slice(0, 63);
  for (let i = 2; await one(`select 1 from agents where handle = $1`, [handle]); i++) handle = `${plat}.${host.handle}.${short}-${i}`.slice(0, 63);
  const row = await one(`insert into agents (handle, platform, role, host_id, session_ref, title, cwd, meta, last_seen_at) values ($1, $2, 'session', $3, $4, $5, $6, $7, now()) returning *`,
    [handle, plat, host.id, ref, title ? String(title).slice(0, 200) : null, cwd || null, JSON.stringify(meta)]);
  await q(`insert into activity (agent_id, type, summary) values ($1, 'session:start', $2)`, [row.id, `${plat} session started in ${cwd ? path.basename(cwd) : 'unknown folder'}`]);
  return row;
}
