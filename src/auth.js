// Who is calling. Two ways to prove it:
//   Authorization: Bearer hpx_...   one secret key per agent (hosted assistants: Instinct, Hark)
//   Hpx-Agent / Hpx-Timestamp / Hpx-Nonce / Hpx-Signature
//                                   an Ed25519 signature over the request (the hpx CLI, hooks)
// A host may act for one of its own session agents with Hpx-As: <handle or id>.
import crypto from 'node:crypto';
import { q, one, tx } from './db.js';
import { fail } from './http.js';

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const newKey = () => 'hpx_' + crypto.randomBytes(32).toString('base64url');
export const newCode = () => 'inv_' + crypto.randomBytes(18).toString('base64url');
const SKEW_MS = 5 * 60 * 1000;

const AGENT_COLS = `a.id, a.handle, a.platform, a.role, a.title, a.host_id, a.session_ref, a.cwd, a.poll_seconds, a.state, a.summary, a.reply_to, a.meta, a.last_seen_at`;

// The exact bytes a client signs.
export const signingString = ({ method, path, timestamp, nonce, body }) =>
  [method.toUpperCase(), path, timestamp, nonce, sha256(body || Buffer.alloc(0))].join('\n');

export async function authenticate(req, url) {
  const h = req.headers;
  let agent, credentialId;
  if (h['hpx-signature']) {
    const ts = Number(h['hpx-timestamp']), nonce = String(h['hpx-nonce'] || '');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS) fail(401, 'Signature timestamp is missing or more than 5 minutes off. Check the clock.');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) fail(401, 'Hpx-Nonce must be 16 to 64 url-safe characters.');
    const rows = (await q(`select c.id as cid, c.public_key, ${AGENT_COLS} from credentials c join agents a on a.id = c.agent_id
      where a.id::text = $1 and c.kind = 'ed25519' and c.revoked_at is null and a.retired_at is null`, [String(h['hpx-agent'] || '')]).catch(() => ({ rows: [] }))).rows;
    const data = Buffer.from(signingString({ method: req.method, path: url.pathname + url.search, timestamp: String(ts), nonce, body: req.rawBody }));
    const sig = Buffer.from(String(h['hpx-signature']), 'base64');
    const hit = rows.find(r => { try { return crypto.verify(null, data, { key: Buffer.from(r.public_key, 'base64'), format: 'der', type: 'spki' }, sig); } catch { return false; } });
    if (!hit) fail(401, 'Signature does not match a key for this agent.');
    const fresh = await one(`insert into nonces (nonce) values ($1) on conflict do nothing returning nonce`, [`${hit.id}:${nonce}`]);
    if (!fresh) fail(401, 'This request was already used (repeated nonce).');
    const { cid, public_key, ...rest } = hit;
    credentialId = cid; agent = rest;
  } else {
    const m = /^Bearer\s+(hpx_[A-Za-z0-9_-]{20,})\s*$/.exec(h.authorization || '');
    // links for agents that can only open URLs: ?key= works on GET requests
    const key = m?.[1] || (req.method === 'GET' ? url.searchParams.get('key') : null);
    if (!key) return null;
    const hit = await one(`select c.id as cid, ${AGENT_COLS} from credentials c join agents a on a.id = c.agent_id
      where c.key_hash = $1 and c.kind = 'key' and c.revoked_at is null and a.retired_at is null`, [sha256(key)]);
    if (!hit) fail(401, 'Unknown or revoked key.');
    const { cid, ...rest } = hit;
    credentialId = cid; agent = rest;
  }
  const principal = agent;
  if (h['hpx-as']) {
    if (agent.role !== 'host') fail(403, 'Only a host can act for another agent.');
    const as = String(h['hpx-as']);
    const child = await one(`select ${AGENT_COLS} from agents a where (a.id::text = $1 or a.handle = $1) and a.host_id = $2 and a.retired_at is null`, [as, agent.id]);
    if (!child) fail(403, `${as} is not one of this host's sessions.`);
    agent = child;
  }
  // presence: any authenticated request counts as being seen (written at most every 10s)
  q(`update agents set last_seen_at = now() where id = any($1) and (last_seen_at is null or last_seen_at < now() - interval '10 seconds')`, [[...new Set([agent.id, principal.id])]]).catch(() => {});
  q(`update credentials set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [credentialId]).catch(() => {});
  return { agent, principal };
}

export function requireRole(ctx, ...roles) {
  if (!roles.includes(ctx.agent.role) && !roles.includes(ctx.principal.role)) fail(403, `This needs one of these roles: ${roles.join(', ')}.`);
}

/* ------------------------------------------------------------ invites and connecting */
export async function createInvite({ role = 'agent', platform = null, handle = null, note = null, hours = 72 } = {}) {
  if (!['driver', 'agent', 'host'].includes(role)) fail(400, 'role must be driver, agent or host.');
  const code = newCode();
  await q(`insert into invites (code_hash, role, platform, handle, note, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [sha256(code), role, platform, handle, note, Math.min(Math.max(1, hours), 24 * 30)]);
  return code;
}
export const inviteFor = code => one(`select role, platform, handle, note, expires_at, used_at from invites where code_hash = $1`, [sha256(String(code || ''))]);

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 40);

// Turn an invite into an agent with its own credential. Returns the bearer key once (never stored).
export async function redeem(code, { handle, platform, title, poll_seconds, public_key } = {}) {
  return tx(async db => {
    const inv = await db.one(`select * from invites where code_hash = $1 for update`, [sha256(String(code || ''))]);
    if (!inv) fail(404, 'That connect link is not valid.');
    if (inv.used_at) fail(410, 'That connect link was already used. Ask for a new one.');
    if (new Date(inv.expires_at) < new Date()) fail(410, 'That connect link has expired. Ask for a new one.');
    const plat = slug(platform || inv.platform || 'agent') || 'agent';
    let base = slug(handle || inv.handle || plat);
    if (base.length < 2) base = plat;
    let h = base;
    for (let i = 2; await db.one(`select 1 from agents where handle = $1`, [h]); i++) h = `${base}-${i}`;
    if (public_key) {
      try { crypto.createPublicKey({ key: Buffer.from(public_key, 'base64'), format: 'der', type: 'spki' }); } catch { fail(400, 'public_key must be a base64 Ed25519 SPKI key.'); }
    }
    const poll = Number.isInteger(poll_seconds) ? Math.min(Math.max(poll_seconds, 5), 86400) : inv.role === 'host' ? 30 : 300;
    const agent = await db.one(`insert into agents (handle, platform, role, title, poll_seconds, last_seen_at) values ($1, $2, $3, $4, $5, now()) returning *`,
      [h, plat, inv.role, title ? String(title).slice(0, 200) : null, poll]);
    let key = null;
    if (public_key) await db.q(`insert into credentials (agent_id, kind, public_key) values ($1, 'ed25519', $2)`, [agent.id, public_key]);
    else { key = newKey(); await db.q(`insert into credentials (agent_id, kind, key_hash) values ($1, 'key', $2)`, [agent.id, sha256(key)]); }
    await db.q(`update invites set used_at = now(), used_by = $2 where code_hash = $1`, [inv.code_hash, agent.id]);
    if (inv.role === 'driver') await db.q(`insert into settings (key, value) values ('driver', to_jsonb($1::text)) on conflict (key) do update set value = excluded.value`, [agent.id]);
    await db.q(`insert into activity (agent_id, type, summary) values ($1, 'connected', $2)`, [agent.id, `${h} (${plat}) connected as ${inv.role}`]);
    return { agent, key };
  });
}

// The admin key (HPX_ADMIN_KEY) only bootstraps: it can create invites, nothing else.
export function isAdmin(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  const want = process.env.HPX_ADMIN_KEY;
  if (!m || !want || want.length < 24) return false;
  const a = Buffer.from(sha256(m[1])), b = Buffer.from(sha256(want));
  return crypto.timingSafeEqual(a, b);
}
