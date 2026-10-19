#!/usr/bin/env node
// hpx: Hyperplex from a machine. Connects it as a host, signs every request with its Ed25519 key,
// runs the hooks that put Claude/Codex/pi sessions on the network, and runs the host daemon that
// starts agents, delivers messages to idle sessions, and relays lesson pages.
//
//   hpx connect <connect-link> [--handle mbp]     make this machine a host
//   hpx agents | inbox | send | ask | status | artifact | invite | tools | call
//   hpx hook claude|codex                         (called by the agents' hooks; reads JSON on stdin)
//   hpx session --platform pi --ref <id> ...      register a session (used by the pi extension)
//   hpx host start|stop|status|logs|run           the host daemon
//   hpx install [claude|codex|pi|all] / hpx uninstall
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HOME = os.homedir();
const DIR = process.env.HPX_HOME || path.join(HOME, '.hyperplex');
const CONFIG = path.join(DIR, 'config.json');
const SELF = fileURLToPath(import.meta.url);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const log = (...a) => { try { fs.appendFileSync(path.join(DIR, 'hpx.log'), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };

/* ------------------------------------------------------------ config and signed requests */
const DEFAULTS = {
  allow_roots: [HOME],
  claude_args: ['--permission-mode', 'auto'],
  codex_args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  pi_args: [],
  stop_wait_minutes: 30,        // how long a remotely driven session waits for its next prompt
  notify_on_stop: 'remote',     // 'remote' (sessions driven through Hyperplex), 'always', or 'never'
};
function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { throw new Error(`Not connected. Run: hpx connect <connect-link>`); }
  return { ...DEFAULTS, ...c };
}
const cfg = () => (cfg.v ||= loadConfig());

let DEFAULT_TIMEOUT = 30_000;
async function api(method, p, body, { as, timeout = DEFAULT_TIMEOUT, raw = false } = {}) {
  const c = cfg();
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = String(Date.now()), nonce = crypto.randomBytes(18).toString('base64url');
  const toSign = [method, p, ts, nonce, crypto.createHash('sha256').update(payload).digest('hex')].join('\n');
  const sig = crypto.sign(null, Buffer.from(toSign), crypto.createPrivateKey(c.private_key)).toString('base64');
  const res = await fetch(c.url + p, {
    method, body: body === undefined ? undefined : payload, signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', 'hpx-agent': c.agent_id, 'hpx-timestamp': ts, 'hpx-nonce': nonce, 'hpx-signature': sig, ...(as ? { 'hpx-as': as } : {}) },
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${method} ${p} answered ${res.status}`), { status: res.status, details: data });
  return data;
}

/* ------------------------------------------------------------ argument parsing */
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) opt[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt[k] = argv[++i]; else opt[k] = true; }
    else pos.push(a);
  }
  return { pos, opt };
}
const readStdin = async () => { if (process.stdin.isTTY) return ''; const c = []; for await (const x of process.stdin) c.push(x); return Buffer.concat(c).toString('utf8'); };
const out = (v, json) => console.log(json || typeof v !== 'object' ? (typeof v === 'string' ? v : JSON.stringify(v, null, 2)) : pretty(v));
function pretty(v, ind = '') {
  if (Array.isArray(v)) return v.map(x => `${ind}- ${pretty(x, ind + '  ').trimStart()}`).join('\n');
  if (v && typeof v === 'object') return Object.entries(v).filter(([, x]) => x != null && !(Array.isArray(x) && !x.length)).map(([k, x]) => typeof x === 'object' ? `${ind}${k}:\n${pretty(x, ind + '  ')}` : `${ind}${k}: ${x}`).join('\n');
  return String(v);
}

/* ------------------------------------------------------------ transcripts (claude, codex, pi) */
async function readLines(file, { tail = 0, head = 0 } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = tail ? Math.max(0, size - tail) : 0, len = tail ? size - start : Math.min(size, head || size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (tail && start > 0) lines.shift();
    if (head && len < size) lines.pop();
    return lines.flatMap(l => { if (!l.trim()) return []; try { return [JSON.parse(l)]; } catch { return []; } });
  } finally { await fh.close(); }
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
const PARSE = {
  claude(e) {
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || !e.message) return null;
    const c = e.message.content;
    if (e.type === 'user') {
      if (Array.isArray(c) && c.some(x => x.type === 'tool_result')) return null;
      const t = textOf(c);
      if (e.isMeta || !t || /^<(command-|local-command|system-reminder|bash-)/.test(t.trim())) return null;
      return { role: 'you', text: t, at: e.timestamp };
    }
    const b = Array.isArray(c) ? c : [];
    return { role: 'agent', text: b.filter(x => x.type === 'text').map(x => x.text).join('\n'), tools: b.filter(x => x.type === 'tool_use').map(x => x.name), at: e.timestamp };
  },
  codex(e) {
    const p = e.payload || {};
    if (e.type === 'event_msg' && p.type === 'user_message') return { role: 'you', text: p.message, at: e.timestamp };
    if (e.type === 'event_msg' && p.type === 'agent_message') return { role: 'agent', text: p.message, tools: [], at: e.timestamp };
    if (e.type === 'response_item' && /function_call|custom_tool_call|local_shell_call/.test(p.type || '')) return { role: 'agent', text: '', tools: [p.name || p.type], at: e.timestamp };
    // the Codex app records turns as response items instead of user_message/agent_message events
    if (e.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const t = (p.content || []).filter(x => /text/.test(x.type || '')).map(x => x.text).join('\n').trim();
      if (!t || (p.role === 'user' && /^<(environment_context|user_instructions|permissions|turn_aborted|heartbeat)/.test(t))) return null;
      return p.role === 'user' ? { role: 'you', text: t, at: e.timestamp } : { role: 'agent', text: t, tools: [], at: e.timestamp };
    }
    return null;
  },
  pi(e) {
    if (e.type !== 'message' || !e.message) return null;
    const m = e.message, c = Array.isArray(m.content) ? m.content : [];
    const t = typeof m.content === 'string' ? m.content : c.filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (m.role === 'user') return t ? { role: 'you', text: t, at: e.timestamp } : null;
    if (m.role === 'assistant') return { role: 'agent', text: t, tools: c.filter(x => x.type === 'toolCall').map(x => x.name), at: e.timestamp };
    return null;
  },
};
async function rounds(platform, file, turns) {
  const parse = PARSE[platform === 'pi-learning' ? 'pi' : platform];
  if (!parse) throw new Error(`Can't read ${platform} transcripts.`);
  const msgs = (await readLines(file, { tail: 3_000_000 })).map(parse).filter(Boolean);
  const rs = [];
  for (const m of msgs) {
    if (m.role === 'you') rs.push({ you: clip(m.text, 2000), at: m.at, agent: [], tools: {} });
    else if (rs.length) { const r = rs.at(-1); if (m.text) r.agent.push(m.text); for (const t of m.tools || []) r.tools[t] = (r.tools[t] || 0) + 1; }
  }
  return rs.slice(-turns).map(r => ({ you: r.you, at: r.at, agent: clip(r.agent.join('\n\n'), 4000), tools_used: r.tools }));
}
async function lastReply(platform, file) {
  try { const msgs = (await readLines(file, { tail: 400_000 })).map(PARSE[platform]).filter(Boolean); return [...msgs].reverse().find(m => m.role === 'agent' && m.text)?.text || ''; } catch { return ''; }
}
async function claudeTitle(file) {
  try {
    let t = null;
    for (const e of await readLines(file, { tail: 300_000 })) if (e.type === 'ai-title' || e.type === 'custom-title') t = e.customTitle || e.aiTitle || t;
    if (t) return t;
    return clip((await readLines(file, { head: 65536 })).map(PARSE.claude).find(m => m?.role === 'you')?.text, 70) || null;
  } catch { return null; }
}
async function codexTitle(id, file) {
  try {
    let t = null;
    for (const l of (await fsp.readFile(path.join(HOME, '.codex/session_index.jsonl'), 'utf8')).split('\n')) { try { const e = JSON.parse(l); if (e.id === id && e.thread_name) t = e.thread_name; } catch {} }
    if (t) return t;
    return file ? clip((await readLines(file, { head: 65536 })).map(PARSE.codex).find(m => m?.role === 'you')?.text, 70) || null : null;
  } catch { return null; }
}

// the agent process a hook belongs to (its nearest claude/codex/pi ancestor)
async function agentPid(names) {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
      const [pp, ...comm] = stdout.trim().split(/\s+/);
      if (names.includes(path.basename(comm.join(' ')))) return pid;
      pid = Number(pp);
    } catch { break; }
  }
  return null;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const inRoots = dir => cfg().allow_roots.some(r => { const rel = path.relative(path.resolve(r.replace(/^~(?=$|\/)/, HOME)), dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });

/* ------------------------------------------------------------ hooks */
const fmtMessages = msgs => msgs.map(m => `Message from ${m.from}${m.kind === 'request' ? ' (needs an answer)' : ''} [id ${m.id}]:\n${m.body}`).join('\n\n');
function contextFor(s, driver) {
  return `You are connected to Hyperplex as \`${s.handle}\`. Dhilan drives you through ${driver ? `\`${driver}\`` : 'the driver agent'}; messages for you arrive here automatically.
- Need a decision from Dhilan before continuing? Run \`hpx ask driver "your question" --as ${s.handle}\`. It waits for the answer and prints it.
- Share plans, diffs and reports for review as artifacts instead of long chat: \`hpx artifact create --as ${s.handle} --kind plan --title "..." --file plan.md\` (or pipe the content in). It prints a review link; Dhilan's verdict comes back as a message.
- Answer a message: \`hpx send --as ${s.handle} --reply <message id> "..."\`. See other agents: \`hpx agents\`.`;
}

async function hook(platform) {
  const input = JSON.parse((await readStdin()) || '{}');
  const event = input.hook_event_name || input.hookEventName;
  const ref = input.session_id || input.sessionId;
  if (!event || !ref) return;
  const transcript = input.transcript_path || null;
  const meta = { transcript };
  if (event === 'SessionStart') {
    meta.pid = await agentPid(platform === 'claude' ? ['claude'] : ['codex']);
    if (process.env.TMUX_PANE) meta.tmux_pane = process.env.TMUX_PANE;
    if (process.env.HPX_LAUNCH_ID) Object.assign(meta, { launched_by: process.env.HPX_LAUNCH_ID, tmux_session: process.env.HPX_TMUX_SESSION, remote: true });
  }
  const title = event === 'SessionStart' || event === 'Stop' ? (platform === 'claude' ? await claudeTitle(transcript) : await codexTitle(ref, transcript)) : null;
  const s = await api('POST', '/v1/sessions', { platform, session_ref: ref, cwd: input.cwd, title, meta });
  const as = s.handle;

  if (event === 'SessionStart') {
    if (process.env.HPX_REPLY_TO) await api('PATCH', '/v1/me', { reply_to: process.env.HPX_REPLY_TO, meta: { remote: true } }, { as }).catch(() => {});
    await api('PATCH', '/v1/me', { state: 'idle' }, { as });
    const me = await api('GET', '/v1/agents/driver').catch(() => null);
    return emit(platform, event, { additionalContext: contextFor(s, me?.handle) });
  }
  if (event === 'UserPromptSubmit') {
    await api('PATCH', '/v1/me', { state: 'working', summary: clip(input.prompt, 300), meta: { listening: false } }, { as });
    const { messages } = await api('GET', '/v1/inbox?limit=10', undefined, { as });
    if (messages.length) return emit(platform, event, { additionalContext: `New Hyperplex messages for you:\n\n${fmtMessages(messages)}` });
    return;
  }
  if (event === 'Notification') {
    // "waiting for your input" is just idle; anything else (a permission prompt) needs a person
    if (/waiting for (your )?input/i.test(input.message || '')) return;
    await api('PATCH', '/v1/me', { state: 'blocked', summary: clip(input.message, 300) }, { as });
    if (s.meta?.remote) await api('POST', '/v1/messages', { to: 'reply_to', kind: 'event', collapse_key: `attention:${as}`,
      body: `${label(platform)} session ${as} (${s.project || 'unknown project'}) needs attention: ${clip(input.message, 300)}. It's waiting on Dhilan's laptop.` }, { as }).catch(() => {});
    return;
  }
  if (event === 'SessionEnd') { await api('PATCH', '/v1/me', { state: 'ended', meta: { listening: false } }, { as }); return; }
  if (event !== 'Stop') return;

  const reply = input.last_assistant_message || (transcript ? await lastReply(platform, transcript) : '');
  await api('PATCH', '/v1/me', { state: 'waiting', summary: clip(reply, 600) || 'Finished its turn.' }, { as });
  const remote = s.meta?.remote, c = cfg();
  if (c.notify_on_stop === 'never' || (c.notify_on_stop === 'remote' && !remote)) return;
  await api('POST', '/v1/messages', { to: 'reply_to', kind: 'event', collapse_key: `done:${as}`, data: { session: as, project: s.project },
    body: `${label(platform)} session ${as} (“${s.title || 'untitled'}”, ${s.project || 'unknown project'}) finished:\n\n${clip(reply, 1800)}\n\nReply to this message with the next prompt, or say "stop".` }, { as });
  // wait here for the next prompt so the session continues the moment it arrives
  const until = Date.now() + c.stop_wait_minutes * 60e3;
  await api('PATCH', '/v1/me', { meta: { listening: true } }, { as });
  const stopListening = () => api('PATCH', '/v1/me', { meta: { listening: false } }, { as }).catch(() => {});
  process.once('SIGTERM', async () => { await stopListening(); process.exit(0); });
  try {
    while (Date.now() < until) {
      const { messages } = await api('GET', '/v1/inbox?wait=25&limit=10', undefined, { as, timeout: 40_000 }).catch(() => ({ messages: [] }));
      if (!messages.length) continue;
      const stop = messages.length === 1 && /^\s*(stop|done|that'?s all|no(thing)?( more)?)\s*\.?\s*$/i.test(messages[0].body);
      await api('PATCH', '/v1/me', { state: stop ? 'idle' : 'working', summary: clip(messages.at(-1).body, 300), meta: { listening: false } }, { as });
      if (stop) return;
      return emit(platform, event, { decision: 'block', reason: `${fmtMessages(messages)}\n\n(Delivered through Hyperplex. When done, just finish your turn; your final message is sent back.)` });
    }
  } finally { await stopListening(); }
}
const label = p => ({ claude: 'Claude', codex: 'Codex', pi: 'Pi' }[p] || p);
function emit(platform, event, o) {
  if (o.decision) return console.log(JSON.stringify({ decision: o.decision, reason: o.reason }));
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: o.additionalContext } }));
}

/* ------------------------------------------------------------ pi and lesson pages */
const PI_DIR = path.join(HOME, '.pi/agent');
const LEARN_DIR = path.join(PI_DIR, 'learn-web');
function learnViews() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(LEARN_DIR, 'sessions')).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try { const c = JSON.parse(fs.readFileSync(path.join(LEARN_DIR, 'sessions', f), 'utf8')); if (!alive(c.pid)) throw 0; out.set(c.sessionId, c); }
    catch { try { fs.unlinkSync(path.join(LEARN_DIR, 'sessions', f)); } catch {} }
  }
  return out;
}
const piCache = new Map();
async function piLessons(days) {
  const since = Date.now() - days * 864e5, root = path.join(PI_DIR, 'sessions'), list = [];
  let dirs = []; try { dirs = await fsp.readdir(root); } catch { return list; }
  for (const d of dirs) {
    let files = []; try { files = (await fsp.readdir(path.join(root, d))).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, d, f);
      let st; try { st = await fsp.stat(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      const hit = piCache.get(file);
      if (hit?.mtimeMs === st.mtimeMs) { if (hit.data) list.push(hit.data); continue; }
      let data = null;
      try {
        const entries = await readLines(file, st.size < 30e6 ? {} : { tail: 2e6 });
        const hdr = entries.find(e => e.type === 'session') || {};
        let name = null, note = null, learning = false;
        const msgs = [];
        for (const e of entries) {
          if (e.type === 'session_info' && e.name) name = e.name;
          if (e.type === 'custom' && e.customType === 'learn-log') { learning = true; note = e.data?.path || note; }
          const m = e.message;
          if (e.type === 'message' && m?.role === 'toolResult' && (m.toolName === 'md_log' || m.toolName === 'quiz')) { learning = true; if (m.details?.path) note = m.details.path; }
          const pm = PARSE.pi(e); if (pm) msgs.push(pm);
          if (pm?.role === 'you' && /^\s*\/(skill:teach|learn-)/.test(pm.text)) learning = true;
        }
        if (learning) {
          const topic = note ? path.basename(note, '.md').replace(/^[^:]*\(\d{4}-\d{2}-\d{2}\):\s*/, '').replace(/^\d{4}-\d{2}-\d{2}-lesson$/, '') || null : null;
          const usable = t => t && !/^\s*[<\/]/.test(t);
          data = { id: hdr.id || f.split('_').pop().replace('.jsonl', ''), file, cwd: hdr.cwd, topic: topic || (usable(name) ? name : null) || clip(msgs.find(m => m.role === 'you')?.text, 70),
            title: name, note, mtimeMs: st.mtimeMs, last_activity: new Date(st.mtimeMs).toISOString(), left_off: clip([...msgs].reverse().find(m => m.role === 'agent' && m.text)?.text, 400) };
        }
      } catch {}
      piCache.set(file, { mtimeMs: st.mtimeMs, data });
      if (data) list.push(data);
    }
  }
  return list.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function pickLesson(list, ref) {
  const r = String(ref || '').trim().toLowerCase();
  for (const t of [x => x.id === r, x => r.length >= 4 && x.id.startsWith(r), x => x.topic?.toLowerCase() === r, x => x.topic?.toLowerCase().includes(r) || x.title?.toLowerCase().includes(r), x => x.cwd?.toLowerCase().includes(r) || x.note?.toLowerCase().includes(r)]) {
    const hit = list.filter(t);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw Object.assign(new Error(`“${ref}” matches ${hit.length} lessons. Ask which one.`), { status: 409, details: { candidates: hit.slice(0, 8).map(x => ({ id: x.id.slice(0, 8), topic: x.topic, last_activity: x.last_activity })) } });
  }
  throw Object.assign(new Error(`No learning session matches “${ref}”.`), { status: 404 });
}
function localHttp(port, { method = 'GET', path: p = '/', headers = {}, body }, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers, host: hostHeader || `127.0.0.1:${port}` }, timeout: 20_000 }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 40e6) req.destroy(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('the lesson page timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
// pids of claude/codex/pi processes whose working folder is dir (so we never start a second copy there)
async function agentsIn(dir, names = ['claude', 'codex', 'pi']) {
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
  const pids = stdout.split('\n').map(l => /^\s*(\d+)\s+(\S+)(?:\s+(\S+))?/.exec(l)).filter(Boolean)
    .filter(([, , exe, arg]) => names.includes(path.basename(exe)) || (/(^|\/)node$/.test(exe) && names.includes(path.basename(arg || ''))))
    .map(m => m[1]);
  if (!pids.length) return [];
  const { stdout: lo } = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]).catch(() => ({ stdout: '' }));
  const out = []; let pid;
  for (const l of lo.split('\n')) { if (l[0] === 'p') pid = Number(l.slice(1)); else if (l[0] === 'n' && path.resolve(l.slice(1)) === path.resolve(dir)) out.push(pid); }
  return out;
}
const claudeTrusts = async dir => fsp.readFile(path.join(HOME, '.claude.json'), 'utf8').then(t => !!JSON.parse(t).projects?.[dir]?.hasTrustDialogAccepted).catch(() => false);
// the lesson server's session cookie, per run of the page (keyed by its secret token)
const lessonCookies = new Map();
async function lessonCookie(view) {
  if (lessonCookies.has(view.token)) return lessonCookies.get(view.token);
  const origin = `http://127.0.0.1:${view.port}`;
  const r = await localHttp(view.port, { method: 'POST', path: '/api/connect', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: view.token }) });
  const cookie = [].concat(r.headers['set-cookie'] || [])[0]?.split(';')[0];
  if (r.status !== 200 || !cookie) throw Object.assign(new Error('Couldn’t sign in to the lesson page.'), { status: 502 });
  lessonCookies.set(view.token, cookie);
  return cookie;
}
const waitFor = async (fn, ms, every = 500) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, every)); } return null; };

/* ------------------------------------------------------------ host daemon */
async function knownFolders() {
  const set = new Set();
  try { for (const k of Object.keys(JSON.parse(await fsp.readFile(path.join(HOME, '.claude.json'), 'utf8')).projects || {})) set.add(k); } catch {}
  try { for (const s of (await api('GET', '/v1/host/sessions')).sessions) if (s.cwd) set.add(s.cwd); } catch {}
  return [...set].filter(d => fs.existsSync(d));
}
async function resolveFolder(ref) {
  const r = String(ref || '').trim().replace(/^~(?=$|\/)/, HOME);
  if (path.isAbsolute(r)) { if (fs.statSync(r, { throwIfNoEntry: false })?.isDirectory()) return path.resolve(r); throw Object.assign(new Error(`${r} isn’t a folder.`), { status: 404 }); }
  const dirs = await knownFolders(), name = r.toLowerCase();
  for (const t of [d => path.basename(d).toLowerCase() === name, d => path.basename(d).toLowerCase().includes(name)]) {
    const hit = dirs.filter(t);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw Object.assign(new Error(`“${ref}” matches several folders. Use the full path.`), { status: 409, details: { candidates: hit.slice(0, 10) } });
  }
  throw Object.assign(new Error(`No known project folder called “${ref}”. Use a full path.`), { status: 404 });
}
const tmuxEnv = env => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
function agentCommand(platform, prompt, { resume, file } = {}) {
  const c = cfg();
  if (platform === 'claude') return ['claude', ...c.claude_args, ...(resume ? ['--resume', resume] : []), ...(prompt ? [prompt] : [])];
  if (platform === 'codex') return ['codex', ...c.codex_args, ...(resume ? ['resume', resume] : []), ...(prompt ? [prompt] : [])];
  if (platform === 'pi' || platform === 'pi-learning') return ['pi', ...c.pi_args, ...(file ? ['--session', file] : []), ...(prompt ? ['--', prompt] : [])];
  throw Object.assign(new Error(`Can’t start ${platform}.`), { status: 400 });
}
async function launch(platform, dir, cmdPrompt, { resume, file, replyTo } = {}) {
  if (!inRoots(dir)) throw Object.assign(new Error(`${dir} is outside the folders this machine lets agents run in (allow_roots).`), { status: 403 });
  const launchId = crypto.randomBytes(6).toString('hex'), name = `hpx-${platform}-${launchId}`;
  const env = { HPX_LAUNCH_ID: launchId, HPX_TMUX_SESSION: name, ...(replyTo ? { HPX_REPLY_TO: replyTo } : {}) };
  await run('tmux', ['new-session', '-d', '-s', name, '-c', dir, ...tmuxEnv(env), ...agentCommand(platform, cmdPrompt, { resume, file })]);
  return { launchId, name };
}

const ops = {
  async start_session({ platform, project, prompt, reply_to }) {
    const dir = await resolveFolder(project);
    if (platform === 'claude') {
      // Claude asks before it works in a folder for the first time; that's Dhilan's call, not ours
      const trusted = await fsp.readFile(path.join(HOME, '.claude.json'), 'utf8').then(t => JSON.parse(t).projects?.[dir]?.hasTrustDialogAccepted).catch(() => false);
      if (!trusted) throw Object.assign(new Error(`Claude hasn’t been trusted in ${dir} yet. Open claude there once on the laptop and accept the folder prompt, then try again.`), { status: 409 });
    }
    const { launchId, name } = await launch(platform, dir, prompt, { replyTo: reply_to });
    // the session registers itself from its first hook; wait briefly to report its handle
    const s = await waitFor(async () => (await api('GET', '/v1/host/sessions')).sessions.find(x => x.meta?.launched_by === launchId), 25_000, 1000);
    if (s) return { started: true, platform, folder: dir, tmux: name, handle: s.handle };
    // not registered yet: say what its window shows (often a prompt waiting for a person)
    const screen = await run('tmux', ['capture-pane', '-p', '-t', name]).then(r => r.stdout.split('\n').filter(l => l.trim()).slice(-8).join('\n')).catch(() => null);
    return { started: true, platform, folder: dir, tmux: name, handle: null, note: 'It hasn’t registered yet. Its window shows:', screen };
  },
  async stop_session({ meta }) {
    if (!meta?.tmux_session) throw Object.assign(new Error('Only sessions Hyperplex started can be stopped from here.'), { status: 403 });
    await run('tmux', ['kill-session', '-t', meta.tmux_session]).catch(() => {});
    return { stopped: meta.tmux_session };
  },
  async read_session({ platform, session_ref, transcript, turns = 3 }) {
    let file = transcript;
    if (!file && (platform === 'pi' || platform === 'pi-learning')) file = (await piLessons(60)).find(l => l.id === session_ref)?.file;
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error('Its transcript isn’t on this machine.'), { status: 404 });
    return { rounds: await rounds(platform, file, turns) };
  },
  async learning_list({ days = 14 }) {
    const views = learnViews(), list = await piLessons(days);
    return { summary: list.length ? `${list.length} learning session${list.length === 1 ? '' : 's'} in the last ${days} days.` : `No learning sessions in the last ${days} days.`,
      sessions: list.slice(0, 25).map(l => ({ id: l.id.slice(0, 8), topic: l.topic, folder: l.cwd ? path.basename(l.cwd) : null, last_activity: l.last_activity, open: views.has(l.id), left_off: l.left_off })) };
  },
  async learning_read({ session, turns = 2 }) {
    const l = pickLesson(await piLessons(60), session);
    let note = null;
    if (l.note) { try { const t = await fsp.readFile(l.note, 'utf8'); note = t.length > 6000 ? '…' + t.slice(-6000) : t; } catch {} }
    return { topic: l.topic, id: l.id.slice(0, 8), last_activity: l.last_activity, rounds: await rounds('pi', l.file, turns), lesson_note: note };
  },
  async learning_open({ session }) {
    const l = pickLesson(await piLessons(60), session);
    let view = learnViews().get(l.id), how = 'already open';
    // any pi in that folder might be this session: ask it rather than starting a second copy
    const running = !view && (await agentsIn(l.cwd, ['pi'])).length > 0;
    if (!view && running) {
      fs.mkdirSync(path.join(LEARN_DIR, 'requests'), { recursive: true });
      fs.writeFileSync(path.join(LEARN_DIR, 'requests', l.id), new Date().toISOString(), { mode: 0o600 });
      view = await waitFor(() => learnViews().get(l.id), 12_000);
      if (!view) throw Object.assign(new Error(`pi is running in ${path.basename(l.cwd)} but the lesson page didn’t come up. If that pi was started before the learn extension update, run /reload in it once, then ask again. (Not starting a second copy.)`), { status: 409 });
      how = 'started the web view in the open session';
    } else if (!view) {
      if (!l.cwd || !inRoots(l.cwd)) throw Object.assign(new Error(`${l.cwd} is outside allow_roots.`), { status: 403 });
      const name = `hpx-pi-${l.id.slice(0, 8)}`;
      await run('tmux', ['kill-session', '-t', name]).catch(() => {});
      await run('tmux', ['new-session', '-d', '-s', name, '-c', l.cwd, '-e', 'LEARN_WEB=auto', 'pi', '--session', l.file]);
      view = await waitFor(() => learnViews().get(l.id), 30_000);
      if (!view) throw Object.assign(new Error(`pi started (tmux ${name}) but its lesson page didn’t come up.`), { status: 500 });
      how = `opened it in tmux (${name}) with the lesson page on`;
    }
    return { port: view.port, token: view.token, topic: l.topic, session_ref: l.id, how };
  },
  // One browser request for a lesson page. Links name the session, not one run of its page: the
  // current page is looked up each time and this host signs in to it, so a pi restart or /reload
  // doesn't break the link on the phone.
  async http({ session, method, path: p, headers = {}, body }) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) throw Object.assign(new Error('Bad path'), { status: 400 });
    const view = learnViews().get(session);
    if (!view) throw Object.assign(new Error('This lesson isn’t running right now. Ask for it again (learning_open) and it will be reopened.'), { status: 410 });
    if (p.split('?')[0] === '/api/connect') return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}').toString('base64') };
    const origin = `http://127.0.0.1:${view.port}`;
    const send = async () => {
      const cookie = await lessonCookie(view);
      const { cookie: _drop, origin: _o, ...rest } = headers;
      return localHttp(view.port, { method, path: p, headers: { ...rest, cookie, ...(method !== 'GET' ? { origin } : {}) }, body: body ? Buffer.from(body, 'base64') : undefined });
    };
    let r = await send();
    if (r.status === 401) { lessonCookies.delete(view.token); r = await send(); }
    const { 'set-cookie': _sc, ...keep } = r.headers;
    return { status: r.status, headers: keep, body: r.body.toString('base64') };
  },
};

async function rpcLoop() {
  let backoff = 1000, up = false;
  for (;;) {
    try {
      const { jobs } = await api('POST', '/v1/host/poll', { host: os.hostname(), version: 1 }, { timeout: 40_000 });
      if (!up) { console.log(new Date().toISOString(), 'connected to', cfg().url, 'as', cfg().handle); up = true; }
      backoff = 1000;
      for (const j of jobs) (async () => {
        try {
          if (!ops[j.op]) throw Object.assign(new Error(`Unknown operation ${j.op}`), { status: 400 });
          const result = await ops[j.op](j.args || {});
          await api('POST', '/v1/host/reply', { id: j.id, ok: true, result }, { timeout: 120_000 });
          if (j.op !== 'http') console.log(new Date().toISOString(), 'ran', j.op);
        } catch (e) {
          console.log(new Date().toISOString(), 'failed', j.op, e.message);
          await api('POST', '/v1/host/reply', { id: j.id, ok: false, error: e.message, status: e.status || 500, details: e.details }).catch(() => {});
        }
      })();
    } catch (e) {
      if (up) console.log(new Date().toISOString(), 'lost the server:', e.message);
      up = false;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// Messages for sessions that aren't listening: type them into tmux, or reopen closed sessions in tmux.
const delivering = new Set();
async function deliveryLoop() {
  for (;;) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { sessions } = await api('GET', '/v1/host/pending');
      for (const s of sessions) {
        if (delivering.has(s.id) || s.meta?.listening || s.state === 'working') continue;
        delivering.add(s.id);
        deliver(s).catch(e => console.log(new Date().toISOString(), 'deliver', s.handle, e.message)).finally(() => delivering.delete(s.id));
      }
    } catch (e) { if (e.status !== undefined) console.log(new Date().toISOString(), 'pending check failed:', e.message); }
  }
}
async function deliver(s) {
  const as = s.handle, pid = s.meta?.pid, open = pid && alive(pid);
  if (open && !s.meta?.tmux_pane) return;   // open in a plain terminal: it gets the message at its next prompt (UserPromptSubmit hook)
  if (s.platform === 'pi' || s.platform === 'pi-learning') return;   // the pi extension polls for itself
  if (!open) {
    // reopening: never alongside another agent in that folder (it may be this very session, resumed by hand)
    if (!s.cwd || !fs.existsSync(s.cwd) || !inRoots(s.cwd)) return;
    if ((await agentsIn(s.cwd)).length) return;
    if (s.platform === 'claude' && !(await claudeTrusts(s.cwd))) return;
  }
  // claim without acknowledging: if delivery fails, the message is offered again
  const { messages } = await api('GET', '/v1/inbox?limit=10&ack=manual', undefined, { as });
  if (!messages.length) return;
  const text = `${fmtMessages(messages)}\n\n(Delivered through Hyperplex.)`;
  const replyTo = messages.at(-1).from;
  if (open) {
    await run('tmux', ['send-keys', '-t', s.meta.tmux_pane, '-l', text]);
    await run('tmux', ['send-keys', '-t', s.meta.tmux_pane, 'Enter']);
    console.log(new Date().toISOString(), 'typed message into', as);
  } else {
    const { name } = await launch(s.platform, s.cwd, text, { resume: s.session_ref, replyTo });
    console.log(new Date().toISOString(), 'reopened', as, 'in tmux', name);
  }
  await api('POST', '/v1/inbox/ack', { ids: messages.map(m => m.id) }, { as });
  await api('PATCH', '/v1/me', { state: 'working', summary: clip(messages.at(-1).body, 300) }, { as });
}
// sessions whose process is gone have ended
async function livenessLoop() {
  for (;;) {
    try {
      for (const s of (await api('GET', '/v1/host/sessions')).sessions) {
        if (s.meta?.pid && !alive(s.meta.pid)) await api('PATCH', '/v1/me', { state: 'ended', meta: { listening: false, pid: null, tmux_pane: null } }, { as: s.handle }).catch(() => {});
      }
    } catch {}
    await new Promise(r => setTimeout(r, 30_000));
  }
}

async function hostCmd(sub) {
  const logFile = path.join(DIR, 'host.log');
  if (sub === 'run') { cfg(); rpcLoop(); deliveryLoop(); livenessLoop(); return new Promise(() => {}); }
  if (sub === 'start') {
    if (await run('tmux', ['has-session', '-t', 'hpx-host']).then(() => true, () => false)) return console.log('already running');
    const pathEnv = [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
    // a clean environment: agents started from here must not inherit a parent agent session
    await run('tmux', ['new-session', '-d', '-s', 'hpx-host', `env -i HOME='${HOME}' USER='${os.userInfo().username}' LANG=en_US.UTF-8 PATH='${pathEnv}' '${process.execPath}' '${SELF}' host run 2>&1 | tee -a '${logFile}'`]);
    await new Promise(r => setTimeout(r, 2500));
    return console.log(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-2).join('\n') : 'started');
  }
  if (sub === 'stop') return console.log(await run('tmux', ['kill-session', '-t', 'hpx-host']).then(() => 'stopped', () => 'not running'));
  if (sub === 'logs') return spawn('tail', ['-n', '50', '-f', logFile], { stdio: 'inherit' });
  const on = await run('tmux', ['has-session', '-t', 'hpx-host']).then(() => true, () => false);
  console.log(on ? 'running' : 'not running');
  if (fs.existsSync(logFile)) console.log(fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n'));
}

/* ------------------------------------------------------------ install */
const HOOK_EVENTS = { claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd'], codex: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] };
const BIN = path.join(DIR, 'bin', 'hpx.mjs');
const hookCommand = p => `node '${BIN}' hook ${p}`;
function installCli() {
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  fs.copyFileSync(SELF, BIN); fs.chmodSync(BIN, 0o755);
  const link = path.join(HOME, '.local/bin/hpx');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(BIN, link);
  return link;
}
function editHooks(file, platform, add) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, `${file}.hpx-backup`); } catch {}
  j.hooks ||= {};
  for (const ev of HOOK_EVENTS[platform]) {
    const groups = (j.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes('hpx.mjs')) })).filter(g => g.hooks.length);
    if (add) groups.push({ hooks: [{ type: 'command', command: hookCommand(platform), timeout: ev === 'Stop' ? (cfg().stop_wait_minutes + 2) * 60 : 15 }] });
    if (groups.length) j.hooks[ev] = groups; else delete j.hooks[ev];
  }
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
}
const PI_EXT = path.join(PI_DIR, 'extensions', 'hyperplex.ts');
function install(what, add = true) {
  const targets = what === 'all' || !what ? ['claude', 'codex', 'pi'] : [what];
  const done = [];
  if (add) done.push(`hpx -> ${installCli()}`);
  for (const t of targets) {
    if (t === 'claude') { editHooks(path.join(HOME, '.claude/settings.json'), 'claude', add); done.push('claude hooks'); }
    if (t === 'codex') { editHooks(path.join(HOME, '.codex/hooks.json'), 'codex', add); done.push('codex hooks'); }
    if (t === 'pi') {
      try { fs.unlinkSync(PI_EXT); } catch {}
      if (add) { fs.mkdirSync(path.dirname(PI_EXT), { recursive: true }); fs.copyFileSync(path.join(path.dirname(SELF), '..', 'integrations', 'pi', 'hyperplex.ts'), PI_EXT); }
      done.push('pi extension');
    }
  }
  console.log(`${add ? 'installed' : 'removed'}: ${done.join(', ')}`);
}

/* ------------------------------------------------------------ commands */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const as = opt.as || process.env.HPX_AS || undefined;
  const json = !!opt.json;
  switch (cmd) {
    case 'connect': {
      const link = new URL(pos[0] || fail('Usage: hpx connect <connect-link> [--handle name]'));
      const code = link.pathname.split('/').filter(Boolean).pop();
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const res = await fetch(`${link.origin}/v1/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        invite: code, handle: opt.handle || os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30), platform: opt.platform || process.platform,
        title: opt.title || `${os.hostname()} (${os.userInfo().username})`, poll_seconds: 30, public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }) });
      const r = await res.json();
      if (!res.ok) fail(r.error || `connect failed (${res.status})`);
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONFIG, JSON.stringify({ url: link.origin, agent_id: r.agent.id, handle: r.agent.handle, role: r.agent.role,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, null, 2), { mode: 0o600 });
      cfg.v = null;
      return console.log(`Connected as ${r.agent.handle} (${r.agent.role}). Config: ${CONFIG}\nNext: hpx install all && hpx host start`);
    }
    case 'whoami': return out(await api('GET', '/v1/me', undefined, { as }), json);
    case 'agents': { const r = await api('GET', `/v1/agents${opt.all ? '?include_ended=true' : ''}`); return out(json ? r : r.agents.map(a => `${a.status.padEnd(7)} ${a.state.padEnd(8)} ${a.handle}${a.project ? `  (${a.project})` : ''}${a.summary ? `  ${clip(a.summary, 70)}` : ''}`).join('\n') || 'No agents.', json); }
    case 'send': {
      const body = pos.slice(opt.reply ? 0 : 1).join(' ') || await readStdin();
      return out(await api('POST', '/v1/messages', { to: opt.reply ? undefined : pos[0], in_reply_to: opt.reply, body, kind: opt.kind, collapse_key: opt.collapse }, { as }), json);
    }
    case 'ask': {
      const to = pos[0], body = pos.slice(1).join(' ') || await readStdin();
      const wait = Number(opt.wait || 1800) * 1000, until = Date.now() + wait;
      const sent = await api('POST', '/v1/messages', { to, body, kind: 'request' }, { as });
      const thread = sent.message.thread_id;
      // reserve the thread so hooks and the host leave the answer for us
      const mine = (await api('GET', '/v1/me', undefined, { as })).meta?.asking || [];
      await api('PATCH', '/v1/me', { state: 'waiting', summary: `Asked ${sent.recipient.handle}: ${clip(body, 200)}`, meta: { asking: [...mine, thread].slice(-10) } }, { as });
      const release = async () => { const cur = (await api('GET', '/v1/me', undefined, { as }).catch(() => ({}))).meta?.asking || []; await api('PATCH', '/v1/me', { state: 'working', meta: { asking: cur.filter(t => t !== thread) } }, { as }).catch(() => {}); };
      process.once('SIGINT', async () => { await release(); process.exit(130); });
      process.stderr.write(`Asked ${sent.recipient.handle}. Waiting for the answer...\n`);
      try {
        while (Date.now() < until) {
          const { messages } = await api('GET', `/v1/inbox?wait=25&limit=1&thread=${thread}`, undefined, { as, timeout: 40_000 }).catch(() => ({ messages: [] }));
          if (messages.length) return out(json ? messages[0] : `${messages[0].from}: ${messages[0].body}`, json);
        }
      } finally { await release(); }
      return fail(`No answer within ${wait / 60000} minutes. It will be in your inbox (thread ${sent.message.thread_id}).`);
    }
    case 'inbox': { const r = await api('GET', `/v1/inbox?wait=${Number(opt.wait) || 0}&limit=${Number(opt.limit) || 20}`, undefined, { as, timeout: 40_000 }); return out(json ? r : r.messages.length ? fmtMessages(r.messages) : 'No new messages.', json); }
    case 'status': return out(await api('PATCH', '/v1/me', { state: pos[0], summary: pos.slice(1).join(' ') || undefined }, { as }), json);
    case 'artifact': {
      const sub = pos[0];
      if (sub === 'list') return out((await api('GET', `/v1/artifacts${opt.status ? `?status=${opt.status}` : ''}`)).artifacts.map(a => `${a.status.padEnd(17)} ${a.kind.padEnd(9)} ${a.title}  ${a.url}`).join('\n') || 'No artifacts.', json);
      const content = opt.file ? fs.readFileSync(opt.file, 'utf8') : await readStdin();
      if (sub === 'create') { const a = await api('POST', '/v1/artifacts', { title: opt.title || fail('--title is required'), kind: opt.kind || 'doc', format: opt.format, content, status: opt.status || 'ready' }, { as }); return out(json ? a : `${a.title} (${a.kind}, v${a.version}): ${a.url}`, json); }
      if (sub === 'update') { const a = await api('PATCH', `/v1/artifacts/${pos[1]}`, { content: content || undefined, status: opt.status, title: opt.title, note: opt.note }, { as }); return out(json ? a : `v${a.version}: ${a.url}`, json); }
      return fail('Usage: hpx artifact create|update <id>|list ...');
    }
    case 'invite': { const r = await api('POST', '/v1/invites', { platform: opt.platform, role: opt.role || 'agent', handle: opt.handle, note: opt.note }); return out(json ? r : r.url, json); }
    case 'tools': return out((await api('GET', '/v1/tools')).tools.map(t => `${t.toolset.padEnd(10)} ${t.name}`).join('\n'), json);
    case 'call': {
      const args = Object.fromEntries(pos.slice(1).map(kv => { const i = kv.indexOf('='); const v = kv.slice(i + 1); return [kv.slice(0, i), /^(true|false|\d+)$/.test(v) ? JSON.parse(v) : v]; }));
      return out((await api('POST', `/v1/tools/${pos[0]}`, args, { as, timeout: 90_000 })).result, json);
    }
    case 'session': {
      const s = await api('POST', '/v1/sessions', { platform: opt.platform, session_ref: opt.ref, cwd: opt.cwd, title: opt.title, meta: opt.meta ? JSON.parse(opt.meta) : {} });
      if (opt['reply-to'] || opt.state) await api('PATCH', '/v1/me', { reply_to: opt['reply-to'], state: opt.state }, { as: s.handle });
      return console.log(JSON.stringify(s));
    }
    case 'hook': DEFAULT_TIMEOUT = 8000; return hook(pos[0]).catch(e => log('hook', pos[0], e.message));   // never break or stall the agent
    case 'host': return hostCmd(pos[0] || 'status');
    case 'install': return install(pos[0], true);
    case 'uninstall': return install(pos[0], false);
    default:
      console.log(`hpx: Hyperplex from this machine
  connect <link> [--handle mbp]      connect this machine (a host invite)
  agents [--all]                     who is up and what they're doing
  send <to> <text> | --reply <id>    message an agent (to: handle or "driver")
  ask <to> <question> [--wait 1800]  ask and wait for the answer
  inbox [--wait 25]                  new messages
  status <state> [summary]           working | idle | waiting | blocked
  artifact create --title T --kind plan [--file f]   share for review (prints a link)
  artifact update <id> [--file f] [--status s] | artifact list
  invite [--platform hark] [--role agent|driver|host]  a one-time connect link
  tools | call <tool> key=value ...
  host start|stop|status|logs        the daemon that runs agents and delivers messages
  install [claude|codex|pi|all] | uninstall [...]
Add --as <session handle> to act as one of this machine's sessions, --json for raw output.`);
  }
}
function fail(msg) { throw new Error(msg); }
main().catch(e => { if (process.argv[2] !== 'hook') { console.error(`hpx: ${e.message}${e.details?.candidates ? `\n${JSON.stringify(e.details.candidates, null, 2)}` : ''}`); process.exit(1); } });
