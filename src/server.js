// Hyperplex: identities, inboxes, tools and artifacts for Dhilan's agents.
import http from 'node:http';
import crypto from 'node:crypto';
import { q, one, all, migrate, listen } from './db.js';
import { router, send, readJson, readBody, fail, HttpError } from './http.js';
import { authenticate, requireRole, redeem, inviteFor, createInvite, isAdmin } from './auth.js';
import * as agents from './agents.js';
import * as messages from './messages.js';
import * as artifacts from './artifacts.js';
import * as rpc from './rpc.js';
import * as relay from './relay.js';
import { allTools, callTool, toolView, available, allowed } from './tools/registry.js';
import { handleMcp } from './mcp.js';
import * as docs from './docs.js';
import { briefing } from './briefing.js';

const PORT = Number(process.env.PORT) || 8080;
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const r = router();
const agentCtx = req => ({ agent: req.auth.agent, principal: req.auth.principal, base: BASE });
const me = req => req.auth.agent;
const md = (res, text) => send(res, 200, text, 'text/markdown; charset=utf-8');

// per-IP limits for the unauthenticated endpoints
const ipHits = new Map();
function ipLimit(req, max = 20) {
  const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress, now = Date.now();
  const h = ipHits.get(ip) || { n: 0, reset: now + 600e3 };
  if (h.reset < now) { h.n = 0; h.reset = now + 600e3; }
  h.n++; ipHits.set(ip, h);
  if (h.n > max) fail(429, 'Too many attempts from here. Try again in 10 minutes.');
}

/* ------------------------------------------------------------ public */
r.get('/health', () => ({ ok: true }));
r.get('/', (req, res) => md(res, docs.landing(BASE)));
r.get('/docs', async (req, res) => md(res, docs.reference(BASE, (await allTools().then(m => [...m.values()])).map(toolView))));
r.get('/llms.txt', async (req, res) => md(res, docs.landing(BASE) + '\n' + docs.reference(BASE, (await allTools().then(m => [...m.values()])).map(toolView))));

r.get('/connect/:code', async (req, res, p) => {
  ipLimit(req, 60);
  const inv = await inviteFor(p.code);
  if (!inv) fail(404, 'That connect link is not valid.');
  if (inv.used_at) fail(410, 'That connect link was already used. Ask for a new one.');
  if (new Date(inv.expires_at) < new Date()) fail(410, 'That connect link has expired. Ask for a new one.');
  md(res, docs.connectPage(BASE, p.code, inv));
});
async function connect(input) {
  const { agent, key } = await redeem(input.invite, input);
  const drv = await agents.driverId();
  const driver = drv ? (await one(`select handle from agents where id = $1`, [drv]))?.handle : null;
  return { agent: { ...agents.view(agent, { driverId: drv }), id: agent.id }, ...(key ? { api_key: key } : {}), driver, instructions: docs.loop(BASE, agent, driver), docs: `${BASE}/docs` };
}
r.post('/v1/connect', async req => {
  ipLimit(req);
  const b = req.body;
  return connect({ invite: b.invite, handle: b.handle, platform: b.platform, title: b.title, poll_seconds: Number.isInteger(b.poll_seconds) ? b.poll_seconds : undefined, public_key: b.public_key });
});
// for agents that can only open links
r.get('/connect/:code/accept', async (req, res, p) => {
  ipLimit(req);
  const u = req.url_;
  const out = await connect({ invite: p.code, handle: u.searchParams.get('handle'), platform: u.searchParams.get('platform'), title: u.searchParams.get('title'),
    poll_seconds: Number(u.searchParams.get('poll_seconds')) || undefined });
  md(res, `# Connected\n\nYou are **${out.agent.handle}**. Your API key (store it privately, it is shown only once):\n\n\`${out.api_key}\`\n\nUse it as \`Authorization: Bearer <key>\`, or add \`?key=<key>\` to GET links such as \`${BASE}/v1/tools/check_inbox?key=<key>\`.\n\n${out.instructions}`);
});

// artifact review pages (capability links)
r.get('/a/:id', async (req, res, p) => {
  const a = await artifacts.get(p.id);
  const t = req.url_.searchParams.get('t') || '';
  if (!t || t.length !== a.view_token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(a.view_token))) fail(404, 'Artifact not found.');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': artifacts.pageCsp(nonce), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  res.end(artifacts.page(a, t, nonce));
});
r.get('/a/:id/raw', async (req, res, p) => {
  const a = await artifacts.get(p.id);
  const t = req.url_.searchParams.get('t') || '';
  if (a.format !== 'html' || !t || t.length !== a.view_token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(a.view_token))) fail(404, 'Not found.');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': artifacts.rawCsp, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(a.content);
});
r.post('/a/:id/review', async (req, res, p) => {
  const f = new URLSearchParams(req.rawBody?.toString('utf8') || '');
  const out = await artifacts.review(p.id, f.get('t'), { decision: f.get('decision'), comment: f.get('comment') });
  send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">Marked as ${out.status.replace('_', ' ')}. The author has been told. <a href="/a/${p.id}?t=${encodeURIComponent(f.get('t'))}">Back</a></p>`, 'text/html; charset=utf-8');
});

/* ------------------------------------------------------------ authenticated */
const auth = async (req, res) => {
  req.auth = await authenticate(req, req.url_);
  if (!req.auth) fail(401, `Send your key as “Authorization: Bearer hpx_...”. New here? Ask for a connect link. Docs: ${BASE}/docs`);
};

r.post('/v1/invites', async req => {
  if (!isAdmin(req)) { await auth(req); requireRole(req.auth, 'driver', 'host'); }
  const code = await createInvite(req.body);
  return { url: `${BASE}/connect/${code}`, expires_in_hours: req.body.hours || 72 };
});

r.get('/v1/me', auth, async req => ({ ...agents.view(me(req), { driverId: await agents.driverId() }), meta: (await one(`select meta from agents where id = $1`, [me(req).id])).meta }));
r.get('/v1/me/instructions', auth, async (req, res) => {
  const drv = await agents.driverId();
  md(res, docs.loop(BASE, me(req), drv ? (await one(`select handle from agents where id = $1`, [drv]))?.handle : null));
});
const META_KEYS = ['transcript', 'pid', 'tmux_pane', 'tmux_session', 'remote', 'listening', 'launched_by', 'learning', 'topic', 'note', 'asking'];
r.patch('/v1/me', auth, async req => {
  const b = req.body, a = me(req);
  if (b.poll_seconds !== undefined) {
    const n = Number(b.poll_seconds);
    if (!Number.isInteger(n) || n < 5 || n > 86400) fail(400, 'poll_seconds must be a whole number from 5 to 86400.');
    await q(`update agents set poll_seconds = $2 where id = $1`, [a.id, n]);
  }
  if (b.meta && typeof b.meta === 'object') {
    const meta = Object.fromEntries(Object.entries(b.meta).filter(([k]) => META_KEYS.includes(k)));
    await q(`update agents set meta = meta || $2::jsonb where id = $1`, [a.id, JSON.stringify(meta)]);
  }
  if (b.reply_to) { const t = await agents.resolve(b.reply_to); await q(`update agents set reply_to = $2 where id = $1`, [a.id, t.id]); }
  const row = await agents.setState(a, { state: b.state, summary: b.summary, title: b.title });
  return agents.view(row, { driverId: await agents.driverId() });
});
r.get('/v1/agents', auth, async req => {
  const u = req.url_.searchParams;
  return { agents: await agents.list({ status: u.get('status') || undefined, platform: u.get('platform') || undefined, includeEnded: u.get('include_ended') === 'true' }) };
});
r.get('/v1/agents/:handle', auth, async (req, res, p) => {
  const a = await agents.resolve(p.handle);
  return (await agents.list({ includeEnded: true })).find(x => x.handle === a.handle) || fail(404, 'Not found.');
});
// retire an agent: the driver can retire anyone; a host its own sessions; anyone themselves
r.delete('/v1/agents/:handle', auth, async (req, res, p) => {
  const a = await agents.resolve(p.handle), caller = me(req), drv = await agents.driverId();
  if (!(caller.id === drv || a.id === caller.id || (a.host_id && a.host_id === req.auth.principal.id))) fail(403, 'You can’t remove that agent.');
  await q(`update agents set retired_at = now(), state = 'ended' where id = $1`, [a.id]);
  await q(`update credentials set revoked_at = now() where agent_id = $1 and revoked_at is null`, [a.id]);
  return { retired: a.handle };
});

r.post('/v1/messages', auth, async req => messages.send(me(req), req.body));
r.get('/v1/inbox', auth, async (req, res) => {
  const u = req.url_.searchParams, ac = new AbortController();
  res.on('close', () => ac.abort());
  const thread = u.get('thread');
  if (thread && !/^[0-9a-f-]{36}$/.test(thread)) fail(400, 'thread must be a thread id.');
  const msgs = await messages.inbox(me(req), { wait: Number(u.get('wait')) || 0, limit: Number(u.get('limit')) || 20, ack: u.get('ack') !== 'manual', thread: thread || undefined }, ac.signal);
  return { messages: msgs, count: msgs.length };
});
r.post('/v1/inbox/ack', auth, async req => messages.ack(me(req), req.body.ids));
r.post('/v1/ask', auth, async req => messages.ask(me(req), { to: req.body.to, body: req.body.body, data: req.body.data, wait: Number(req.body.wait) || 25, thread_id: req.body.thread_id }));
r.get('/v1/threads/:id', auth, async (req, res, p) => ({ messages: await messages.threadView(me(req), p.id) }));

r.post('/v1/artifacts', auth, async req => artifacts.create(me(req), BASE, req.body));
r.get('/v1/artifacts', auth, async req => { const u = req.url_.searchParams; return { artifacts: await artifacts.list(BASE, { status: u.get('status'), kind: u.get('kind'), author: u.get('author'), limit: u.get('limit') }) }; });
r.get('/v1/artifacts/:id', auth, async (req, res, p) => artifacts.detail(await artifacts.get(p.id), BASE));
r.patch('/v1/artifacts/:id', auth, async (req, res, p) => artifacts.update(me(req), BASE, p.id, req.body));

r.get('/v1/briefing', auth, async req => briefing(agentCtx(req)));

r.get('/v1/tools', auth, async req => ({ tools: [...(await allTools()).values()].filter(t => allowed(t, me(req))).map(toolView) }));
r.post('/v1/tools/:name', auth, async (req, res, p) => ({ ok: true, result: await callTool(p.name, req.body, agentCtx(req)) }));
r.get('/v1/tools/:name', auth, async (req, res, p) => {
  const u = req.url_.searchParams;
  const args = Object.fromEntries([...u].filter(([k]) => k !== 'key' && k !== 'format'));
  const result = await callTool(p.name, args, agentCtx(req), { fromQuery: true });
  if (u.get('format') === 'text') return send(res, 200, asText(result).trim() + '\n');
  return { ok: true, result };
});

const INSTRUCTIONS = 'Hyperplex connects Dhilan’s agents. Use briefing to see what is going on, list_agents to see who is up, send_message to talk to them, and create_artifact to share work for review.';
r.post('/mcp', auth, async (req, res) => {
  const reply = await handleMcp(req.body, {
    instructions: INSTRUCTIONS,
    listTools: async () => [...(await allTools()).values()].filter(t => available(t) && allowed(t, me(req))),
    callTool: (name, args) => callTool(name, args, agentCtx(req)),
  });
  if (!reply) { res.writeHead(202); return res.end(); }
  return reply;
});

/* ------------------------------------------------------------ hosts */
const host = async req => { await auth(req); if (req.auth.principal.role !== 'host' || req.auth.agent.id !== req.auth.principal.id) fail(403, 'Only a host machine can do this.'); };
r.post('/v1/sessions', host, async req => {
  const s = await agents.ensureSession(me(req), req.body);
  return { ...agents.view(s, { host: me(req), driverId: await agents.driverId() }), id: s.id, meta: s.meta, reply_to: s.reply_to };
});
r.get('/v1/host/sessions', host, async req => ({ sessions: await all(`select id, handle, platform, session_ref, cwd, state, meta, title from agents where host_id = $1 and retired_at is null and state <> 'ended'`, [me(req).id]) }));
r.get('/v1/host/pending', host, async req => ({ sessions: await all(`select a.id, a.handle, a.platform, a.session_ref, a.cwd, a.state, a.meta, count(m.id)::int as pending
  from agents a join messages m on m.to_agent = a.id and m.acked_at is null and m.expires_at > now() and (m.delivered_at is null or m.delivered_at < now() - interval '2 minutes')
  where a.host_id = $1 and a.retired_at is null group by a.id`, [me(req).id]) }));
r.post('/v1/host/poll', host, async (req, res) => {
  let onClose; res.on('close', () => onClose?.());
  const jobs = await rpc.poll(me(req).id, req.body, f => { onClose = f; });
  if (res.destroyed) { rpc.requeue(me(req).id, jobs); return; }
  return { jobs };
});
r.post('/v1/host/reply', host, async req => ({ ok: rpc.reply(me(req).id, req.body) }));

/* ------------------------------------------------------------ plumbing */
function asText(v, indent = '') {
  if (v === null || v === undefined) return 'none';
  if (Array.isArray(v)) return v.length ? v.map(x => `\n${indent}- ${asText(x, indent + '  ').trimStart()}`).join('') : 'none';
  if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length))
    .map(([k, x]) => `\n${indent}${k}: ${typeof x === 'object' ? asText(x, indent + '  ') : x}`).join('');
  return String(v);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  req.url_ = url;
  try {
    if (await relay.handle(req, res, url)) return;
    const m = r.match(req.method, url.pathname.replace(/\/+$/, '') || '/');
    if (!m) fail(404, `Nothing at ${req.method} ${url.pathname}. See ${BASE}/docs`);
    if (m.notAllowed) fail(405, 'Method not allowed.');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const limit = url.pathname === '/v1/host/reply' ? 64 * 1024 * 1024 : url.pathname.startsWith('/v1/artifacts') || url.pathname.startsWith('/v1/tools') || url.pathname === '/mcp' ? 3 * 1024 * 1024 : 256 * 1024;
      if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) { req.rawBody = await readBody(req, 64 * 1024); req.body = {}; }
      else req.body = await readJson(req, limit);
    } else req.body = {};
    let out;
    for (const h of m.handlers) { out = await h(req, res, m.params); if (res.headersSent) return; }
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError || e.status) return send(res, e.status || 500, { error: e.message, ...(e.details || {}) });
    console.error(req.method, url.pathname, e);
    send(res, 500, { error: 'Something went wrong on our side.' });
  }
});

await migrate();
await listen();
// housekeeping: forget old nonces, expired mail and stale activity
setInterval(() => {
  q(`delete from nonces where seen_at < now() - interval '15 minutes'`).catch(() => {});
  q(`delete from messages where expires_at < now() - interval '30 days'`).catch(() => {});
  q(`delete from activity where created_at < now() - interval '90 days'`).catch(() => {});
}, 10 * 60 * 1000).unref();
server.listen(PORT, () => console.log(`hyperplex on :${PORT} (${BASE})`));
export { server };
