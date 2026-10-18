// End-to-end tests against a real Postgres: TEST_DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL;
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'admin-' + crypto.randomBytes(16).toString('hex');
let server;

const call = async (method, path, { key, body, headers = {}, raw } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const invite = async (role, extra = {}) => (await call('POST', '/v1/invites', { key: ADMIN, body: { role, ...extra } })).data.url.split('/').pop();

// a signing client like hpx
function signer(agentId, privateKey) {
  return async (method, path, body, { as, nonce, tamper } = {}) => {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const ts = String(Date.now()), n = nonce || crypto.randomBytes(18).toString('base64url');
    const str = [method, path, ts, n, crypto.createHash('sha256').update(payload).digest('hex')].join('\n');
    const sig = crypto.sign(null, Buffer.from(str), privateKey).toString('base64');
    const res = await fetch(BASE + path, { method, body: body === undefined ? undefined : (tamper ? Buffer.from(JSON.stringify({ ...body, tampered: 1 })) : payload),
      headers: { 'content-type': 'application/json', 'hpx-agent': agentId, 'hpx-timestamp': ts, 'hpx-nonce': n, 'hpx-signature': sig, ...(as ? { 'hpx-as': as } : {}) } });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

const ctx = {};
before(async () => {
  assert.ok(DB, 'set TEST_DATABASE_URL');
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), PUBLIC_URL: BASE, HPX_ADMIN_KEY: ADMIN }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => String(d).includes('hyperplex on') && resolve()); server.on('exit', reject); });
});
after(() => server?.kill());

test('a driver connects with a POST and gets a key and its loop', async () => {
  const code = await invite('driver', { platform: 'instinct', handle: 'instinct' });
  const page = await call('GET', `/connect/${code}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /POST .*\/v1\/connect/);
  const r = await call('POST', '/v1/connect', { body: { invite: code, handle: 'instinct', platform: 'instinct', poll_seconds: 120 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.api_key, /^hpx_/);
  assert.equal(r.data.agent.role, 'driver');
  assert.match(r.data.instructions, /briefing/);
  ctx.instinct = r.data.api_key;
  assert.equal((await call('POST', '/v1/connect', { body: { invite: code } })).status, 410, 'an invite works once');
});

test('the driver invites hark, which connects by opening a link', async () => {
  const inv = await call('POST', '/v1/tools/create_invite', { key: ctx.instinct, body: { platform: 'hark', handle: 'hark' } });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const code = inv.data.result.url.split('/').pop();
  const page = await call('GET', `/connect/${code}/accept?handle=hark&platform=hark&poll_seconds=60`);
  assert.equal(page.status, 200);
  ctx.hark = /`(hpx_[A-Za-z0-9_-]+)`/.exec(page.data)[1];
  const me = await call('GET', '/v1/me', { key: ctx.hark });
  assert.equal(me.data.handle, 'hark');
  assert.equal(me.data.status, 'online');
});

test('a host connects with an Ed25519 key; signatures are checked and nonces are single-use', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const code = await invite('host');
  const r = await call('POST', '/v1/connect', { body: { invite: code, handle: 'mbp', platform: 'darwin', public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.api_key, undefined, 'no bearer key for signing agents');
  ctx.host = signer(r.data.agent.id, privateKey);
  assert.equal((await ctx.host('GET', '/v1/me')).data.handle, 'mbp');
  assert.equal((await ctx.host('GET', '/v1/me', undefined, { nonce: 'fixed-nonce-1234567890' })).status, 200);
  assert.equal((await ctx.host('GET', '/v1/me', undefined, { nonce: 'fixed-nonce-1234567890' })).status, 401, 'replay rejected');
  assert.equal((await ctx.host('PATCH', '/v1/me', { state: 'idle' }, { tamper: true })).status, 401, 'tampered body rejected');
});

test('a coding session reports to the driver; the driver’s reply reaches it (long poll wakes at once)', async () => {
  const s = await ctx.host('POST', '/v1/sessions', { platform: 'claude', session_ref: 'b9dd2db9-2f4b-40bd-98e1-21ad2366e713', cwd: '/Users/x/margins', title: 'Fix login', meta: { remote: true } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.handle, 'claude.mbp.b9dd2db9');
  ctx.session = s.data.handle;
  const waiting = call('GET', '/v1/inbox?wait=20', { key: ctx.instinct });
  await new Promise(r => setTimeout(r, 300));
  const t0 = Date.now();
  const sent = await ctx.host('POST', '/v1/messages', { to: 'reply_to', kind: 'event', body: 'finished: login fixed. Next prompt?', collapse_key: `done:${ctx.session}` }, { as: ctx.session });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const got = await waiting;
  assert.ok(Date.now() - t0 < 2000, 'woke immediately');
  assert.equal(got.data.messages[0].from, ctx.session);
  const reply = await call('POST', '/v1/messages', { key: ctx.instinct, body: { in_reply_to: got.data.messages[0].id, body: 'Great. Now add tests.' } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.message.to, ctx.session);
  const inbox = await ctx.host('GET', '/v1/inbox', undefined, { as: ctx.session });
  assert.equal(inbox.data.messages[0].body, 'Great. Now add tests.');
  assert.equal(inbox.data.messages[0].kind, 'reply');
  assert.equal((await ctx.host('GET', '/v1/inbox', undefined, { as: ctx.session })).data.messages.length, 0, 'delivered once');
});

test('backpressure: collapse_key replaces, and a flood is refused', async () => {
  for (let i = 0; i < 3; i++) await call('POST', '/v1/messages', { key: ctx.hark, body: { to: 'instinct', body: `progress ${i}`, collapse_key: 'progress' } });
  const pending = await call('GET', '/v1/inbox', { key: ctx.instinct });
  assert.deepEqual(pending.data.messages.map(m => m.body), ['progress 2']);
  let last;
  for (let i = 0; i < 30; i++) last = await call('POST', '/v1/messages', { key: ctx.hark, body: { to: 'instinct', body: `spam ${i}` } });
  assert.equal(last.status, 429);
  assert.match(last.data.error, /hasn’t picked up/);
  await call('GET', '/v1/inbox?limit=100', { key: ctx.instinct });
  const dup1 = await call('POST', '/v1/messages', { key: ctx.hark, body: { to: 'instinct', body: 'once', client_id: 'abc-1' } });
  const dup2 = await call('POST', '/v1/messages', { key: ctx.hark, body: { to: 'instinct', body: 'once', client_id: 'abc-1' } });
  assert.equal(dup2.data.duplicate, true);
  assert.equal(dup1.data.message.id, dup2.data.message.id);
  await call('GET', '/v1/inbox', { key: ctx.instinct });
});

test('presence and listing agents', async () => {
  const r = await call('GET', '/v1/agents', { key: ctx.hark });
  const by = Object.fromEntries(r.data.agents.map(a => [a.handle, a]));
  assert.equal(by.instinct.role, 'driver');
  assert.equal(by.instinct.status, 'online');
  assert.equal(by[ctx.session].status, 'online', 'sessions follow their host');
  assert.equal(by[ctx.session].project, 'margins');
  const one = await call('GET', '/v1/agents/driver', { key: ctx.hark });
  assert.equal(one.data.handle, 'instinct');
});

test('artifacts: created by a session, announced to the driver, reviewed on its page', async () => {
  const a = await ctx.host('POST', '/v1/artifacts', { title: 'Plan: login fix', kind: 'plan', content: '# Plan\n\n1. Fix it' }, { as: ctx.session });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const ev = await call('GET', '/v1/inbox', { key: ctx.instinct });
  assert.match(ev.data.messages[0].body, /shared a plan for review/);
  const u = new URL(a.data.url);
  const page = await call('GET', u.pathname + u.search, { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /nonce-/);
  assert.equal((await call('GET', u.pathname + '?t=wrong', { raw: true })).status, 404);
  const review = await fetch(`${BASE}/a/${a.data.id}/review`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${u.searchParams.get('t')}&decision=changes&comment=${encodeURIComponent('Add a rollback step')}` });
  assert.equal(review.status, 200);
  const back = await ctx.host('GET', '/v1/inbox', undefined, { as: ctx.session });
  assert.match(back.data.messages[0].body, /requested changes[\s\S]*rollback/);
  const v2 = await ctx.host('PATCH', `/v1/artifacts/${a.data.id}`, { content: '# Plan\n\n1. Fix it\n2. Roll back', status: 'ready' }, { as: ctx.session });
  assert.equal(v2.data.version, 2);
  assert.equal((await call('PATCH', `/v1/artifacts/${a.data.id}`, { key: ctx.hark, body: { status: 'approved' } })).status, 403, 'only author or driver');
});

test('tools: list, call, open as a link, briefing, roles', async () => {
  const list = await call('GET', '/v1/tools', { key: ctx.hark });
  const names = list.data.tools.map(t => t.name);
  assert.ok(names.includes('briefing') && names.includes('send_message') && !names.includes('start_agent'), 'role-limited tools hidden');
  const b = await call('POST', '/v1/tools/briefing', { key: ctx.instinct, body: {} });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.ok(b.data.result.agents.list.length >= 3);
  const link = await call('GET', `/v1/tools/send_message?key=${ctx.hark}&to=instinct&body=${encodeURIComponent('hello from a link')}`);
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const text = await call('GET', `/v1/tools/check_inbox?key=${ctx.instinct}&format=text`);
  assert.match(text.data, /hello from a link/);
  assert.equal((await call('POST', '/v1/tools/start_agent', { key: ctx.hark, body: { platform: 'codex', project: 'x', prompt: 'y' } })).status, 403);
  assert.equal((await call('POST', '/v1/tools/nope', { key: ctx.hark, body: {} })).status, 404);
  const bad = await call('POST', '/v1/tools/send_message', { key: ctx.hark, body: { to: 'instinct' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /needs “body”/);
});

test('MCP: initialize, list and call with the same key', async () => {
  const rpc = body => call('POST', '/mcp', { key: ctx.hark, body });
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.data.result.serverInfo.name, 'hyperplex');
  assert.equal((await call('POST', '/mcp', { key: ctx.hark, body: { jsonrpc: '2.0', method: 'notifications/initialized' }, raw: true })).status, 202);
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(tools.data.result.tools.some(t => t.name === 'list_agents'));
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
  assert.equal(r.data.result.isError, false);
  assert.ok(r.data.result.structuredContent.agents.length >= 3);
});

test('a custom tool answered by an agent', async () => {
  const reg = await call('POST', '/v1/tools/register_tool', { key: ctx.instinct, body: { name: 'hark_weather', description: 'Weather via hark', handler: 'agent', agent: 'hark',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const pending = call('POST', '/v1/tools/hark_weather', { key: ctx.instinct, body: { city: 'Austin' } });
  const req = await call('GET', '/v1/inbox?wait=10', { key: ctx.hark });
  const m = req.data.messages.find(x => x.data?.tool === 'hark_weather');
  assert.equal(m.data.args.city, 'Austin');
  await call('POST', '/v1/messages', { key: ctx.hark, body: { in_reply_to: m.id, body: 'sunny', data: { temp_f: 88 } } });
  const res = await pending;
  assert.deepEqual(res.data.result, { temp_f: 88 });
});

test('live calls reach the host and come back', async () => {
  const poller = ctx.host('POST', '/v1/host/poll', {});
  await new Promise(r => setTimeout(r, 200));
  const started = call('POST', '/v1/tools/start_agent', { key: ctx.instinct, body: { platform: 'codex', project: 'hyperplex', prompt: 'add a feature' } });
  const { data } = await poller;
  assert.equal(data.jobs[0].op, 'start_session');
  assert.equal(data.jobs[0].args.reply_to, 'instinct');
  await ctx.host('POST', '/v1/host/reply', { id: data.jobs[0].id, ok: true, result: { started: true, handle: 'codex.mbp.abc' } });
  const r = await started;
  assert.equal(r.data.result.handle, 'codex.mbp.abc');
  const pend = await ctx.host('GET', '/v1/host/pending');
  assert.ok(Array.isArray(pend.data.sessions));
  assert.equal((await call('POST', '/v1/host/poll', { key: ctx.hark, body: {} })).status, 403, 'only hosts poll for jobs');
});

test('the docs render with every toolset', async () => {
  const d = await call('GET', '/docs');
  assert.match(d.data, /### hyperplex/);
  assert.match(d.data, /### learning/);
  assert.doesNotMatch(d.data, /—/, 'no em dashes');
});
