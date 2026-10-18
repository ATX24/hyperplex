// The hyperplex toolset: what any agent needs to work with the others.
import { q, one, all } from '../db.js';
import { fail } from '../http.js';
import * as agents from '../agents.js';
import * as messages from '../messages.js';
import * as artifacts from '../artifacts.js';
import * as rpc from '../rpc.js';
import { createInvite } from '../auth.js';
import { briefing } from '../briefing.js';

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Which machine runs a local action: the named one, else the only connected host.
export async function pickHost(ref) {
  if (ref) {
    const h = await agents.resolve(ref);
    if (h.role !== 'host') fail(400, `${h.handle} is not a host machine.`);
    return h;
  }
  const hosts = (await all(`select * from agents where role = 'host' and retired_at is null`)).filter(h => rpc.connected(h.id));
  if (!hosts.length) fail(503, 'No host machine is connected. The laptop has to be on and running `hpx host`.');
  if (hosts.length > 1) fail(409, 'Several hosts are connected. Say which one with `host`.', { hosts: hosts.map(h => h.handle) });
  return hosts[0];
}
async function sessionAgent(ref) {
  const s = await agents.resolve(ref);
  if (s.role !== 'session') fail(400, `${s.handle} isn’t a coding session.`);
  return { s, host: await one(`select * from agents where id = $1`, [s.host_id]) };
}

const AGENT = { type: 'string', description: 'An agent handle (see list_agents), or “driver” for Dhilan’s main assistant.' };

export default [
  {
    name: 'briefing', toolset: 'hyperplex', readOnly: true,
    description: 'Everything worth knowing right now, in one call: which agents are up and what each is doing, what is waiting on Dhilan (finished sessions, questions, artifacts to review), unread messages, recent activity, and what is new on Margins. Call it when you check in, reflect, or are asked “what’s going on?”.',
    examples: [{ say: 'How is everything going?', args: {} }, { say: 'I wonder how the hark agent is doing', args: {} }],
    run: (_, ctx) => briefing(ctx),
  },
  {
    name: 'list_agents', toolset: 'hyperplex', readOnly: true,
    description: 'Every connected agent: hosted assistants (instinct, hark), machines, and the Claude, Codex and pi sessions they run, with status (online, stale, offline: did it poll when expected?) and state (working, idle, waiting, blocked). Use for “what agents are running?”.',
    input: { type: 'object', properties: {
      status: { type: 'string', enum: ['online', 'stale', 'offline'], description: 'Only agents with this status.' },
      platform: { type: 'string', description: 'Only this platform, e.g. claude, codex, pi, pi-learning, hark.' },
      include_ended: { type: 'boolean', default: false, description: 'Also list coding sessions that have ended.' },
    } },
    run: async a => {
      const list = await agents.list({ status: a.status, platform: a.platform, includeEnded: a.include_ended });
      const count = s => list.filter(x => x.state === s && x.status !== 'ended').length;
      return { summary: `${list.length} agents: ${count('working')} working, ${count('waiting')} waiting for a prompt, ${count('blocked')} blocked.`, agents: list };
    },
  },
  {
    name: 'send_message', toolset: 'hyperplex',
    description: 'Send a message to another agent. To answer a message, pass its id as in_reply_to (then “to” can be left out). To a coding session, the body is delivered as its next prompt. Use collapse_key for status updates so a newer one replaces an unread older one.',
    input: { type: 'object', required: ['body'], properties: {
      to: AGENT,
      body: { type: 'string', maxLength: 32000, description: 'The message. Put long content in an artifact and send its link.' },
      in_reply_to: { type: 'string', description: 'Id of the message you are answering.' },
      thread_id: { type: 'string', description: 'Continue an existing thread.' },
      kind: { type: 'string', enum: ['message', 'request', 'event'], default: 'message', description: 'request = you expect an answer; event = an FYI that needs no answer.' },
      collapse_key: { type: 'string', description: 'Replace your earlier unread message with the same key.' },
    } },
    examples: [{ say: 'Tell the codex session to continue with the plan', args: { to: 'codex.mbp.01a1468a', body: 'Looks good. Continue with the plan.' } }],
    run: async (a, ctx) => messages.send(ctx.agent, a),
  },
  {
    name: 'check_inbox', toolset: 'hyperplex',
    description: 'Collect your new messages (each is returned once). Waits up to wait_seconds for something to arrive. Reply with send_message and in_reply_to.',
    input: { type: 'object', properties: {
      wait_seconds: { type: 'integer', minimum: 0, maximum: 30, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    } },
    run: async (a, ctx) => { const m = await messages.inbox(ctx.agent, { wait: a.wait_seconds, limit: a.limit }); return { messages: m, count: m.length }; },
  },
  {
    name: 'ask_agent', toolset: 'hyperplex',
    description: 'Ask another agent something and wait (up to 30 seconds) for the answer. If it doesn’t answer in time, the answer arrives in your inbox later.',
    input: { type: 'object', required: ['to', 'question'], properties: { to: AGENT, question: { type: 'string', maxLength: 32000 }, wait_seconds: { type: 'integer', minimum: 0, maximum: 30, default: 25 } } },
    run: async (a, ctx) => messages.ask(ctx.agent, { to: a.to, body: a.question, wait: a.wait_seconds }),
  },
  {
    name: 'get_thread', toolset: 'hyperplex', readOnly: true,
    description: 'Read a whole conversation thread.',
    input: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' } } },
    run: async (a, ctx) => ({ messages: await messages.threadView(ctx.agent, a.thread_id) }),
  },
  {
    name: 'set_status', toolset: 'hyperplex',
    description: 'Say what you are doing so the driver and others can see it: working, idle, waiting (for an answer or a prompt) or blocked.',
    input: { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['working', 'idle', 'waiting', 'blocked'] }, summary: { type: 'string', maxLength: 2000 } } },
    run: async (a, ctx) => { const r = await agents.setState(ctx.agent, a); return { state: r.state, summary: r.summary }; },
  },
  {
    name: 'create_artifact', toolset: 'hyperplex',
    description: 'Share something for Dhilan to look at: a plan, a diff to review, a doc, a report or a dashboard. Returns a private link with Approve and Request changes buttons; the decision comes back to you as a message. Prefer this over pasting long content into messages.',
    input: { type: 'object', required: ['title', 'content'], properties: {
      title: { type: 'string', maxLength: 200 },
      kind: { type: 'string', enum: ['plan', 'diff', 'doc', 'report', 'dashboard', 'other'], default: 'doc' },
      format: { type: 'string', enum: ['markdown', 'diff', 'html', 'text', 'json'], description: 'Defaults to markdown (diff for kind=diff). html runs sandboxed: use it for dashboards.' },
      content: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'ready'], default: 'ready', description: 'ready announces it to the driver for review.' },
      thread_id: { type: 'string', description: 'Attach it to a conversation.' },
    } },
    run: async (a, ctx) => artifacts.create(ctx.agent, ctx.base, a),
  },
  {
    name: 'update_artifact', toolset: 'hyperplex',
    description: 'Change an artifact: new content (a new version), title or status.',
    input: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, content: { type: 'string' }, title: { type: 'string', maxLength: 200 },
      status: { type: 'string', enum: ['draft', 'ready', 'approved', 'changes_requested', 'archived'] }, note: { type: 'string', maxLength: 500, description: 'What changed in this version.' },
    } },
    run: async (a, ctx) => artifacts.update(ctx.agent, ctx.base, a.id, a),
  },
  {
    name: 'list_artifacts', toolset: 'hyperplex', readOnly: true,
    description: 'Recent artifacts with their links. Filter by status (ready = waiting for review), kind or author.',
    input: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'ready', 'approved', 'changes_requested'] }, kind: { type: 'string' }, author: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 } } },
    run: async (a, ctx) => ({ artifacts: await artifacts.list(ctx.base, a) }),
  },
  {
    name: 'get_artifact', toolset: 'hyperplex', readOnly: true,
    description: 'Read one artifact’s content.',
    input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: async (a, ctx) => artifacts.detail(await artifacts.get(a.id), ctx.base),
  },
  {
    name: 'read_session', toolset: 'hyperplex', readOnly: true,
    description: 'Read the latest exchanges of a coding session (Claude, Codex or pi) on Dhilan’s laptop: what it was asked, what it answered, which tools it used. Needs the laptop online.',
    input: { type: 'object', required: ['session'], properties: { session: { type: 'string', description: 'The session’s handle (from list_agents).' }, turns: { type: 'integer', minimum: 1, maximum: 20, default: 3 } } },
    run: async a => {
      const { s, host } = await sessionAgent(a.session);
      return { session: s.handle, title: s.title, ...(await rpc.call(host, 'read_session', { platform: s.platform, session_ref: s.session_ref, transcript: s.meta?.transcript, turns: a.turns })) };
    },
  },
  {
    name: 'start_agent', toolset: 'hyperplex', roles: ['driver', 'host'],
    description: 'Start a new Claude, Codex or pi session on Dhilan’s laptop in a project folder, with a first prompt. It runs in a tmux window, reports back to you when it finishes, and takes follow-ups through send_message. Confirm the project and prompt with Dhilan first.',
    input: { type: 'object', required: ['platform', 'project', 'prompt'], properties: {
      platform: { type: 'string', enum: ['claude', 'codex', 'pi'] },
      project: { type: 'string', description: 'A full folder path, or a folder name like “hyperplex” that matches a known project.' },
      prompt: { type: 'string', maxLength: 20000 },
      host: { type: 'string', description: 'Which machine, if more than one is connected.' },
    } },
    examples: [{ say: 'Spin up a codex session on my laptop to add that to hyperplex', args: { platform: 'codex', project: 'hyperplex', prompt: 'Add ...' } }],
    run: async (a, ctx) => {
      const host = await pickHost(a.host);
      const r = await rpc.call(host, 'start_session', { platform: a.platform, project: a.project, prompt: a.prompt, reply_to: ctx.agent.handle }, { timeout: 45_000 });
      return { ...r, note: `It will register as an agent and message ${ctx.agent.handle} when it finishes. Follow its progress with list_agents or read_session.` };
    },
  },
  {
    name: 'stop_agent', toolset: 'hyperplex', roles: ['driver', 'host'],
    description: 'Stop a coding session that Hyperplex started (its tmux window is closed). Sessions Dhilan opened directly are left alone.',
    input: { type: 'object', required: ['session'], properties: { session: { type: 'string' } } },
    run: async a => { const { s, host } = await sessionAgent(a.session); return rpc.call(host, 'stop_session', { platform: s.platform, session_ref: s.session_ref, meta: s.meta }); },
  },
  {
    name: 'create_invite', toolset: 'hyperplex', roles: ['driver', 'host'],
    description: 'Make a one-time connect link for a new agent (for example to paste into a Hark chat). The agent opens it and follows the instructions there. Links expire in 3 days.',
    input: { type: 'object', properties: {
      platform: { type: 'string', description: 'What the agent is, e.g. hark, chatgpt, a machine name.' },
      handle: { type: 'string', description: 'Preferred handle, e.g. hark.' },
      role: { type: 'string', enum: ['agent', 'host', 'driver'], default: 'agent', description: 'driver replaces the current driver; host is for a machine running hpx.' },
      note: { type: 'string', maxLength: 300 },
    } },
    run: async (a, ctx) => { const code = await createInvite(a); return { url: `${ctx.base}/connect/${code}`, expires_in_hours: 72 }; },
  },
  {
    name: 'register_tool', toolset: 'hyperplex', roles: ['driver', 'host'],
    description: 'Add a custom tool everyone can call, without a deploy. handler=http forwards calls to an https URL (body {args, caller}, JSON reply); handler=agent sends the call to an agent as a request and returns its reply.',
    input: { type: 'object', required: ['name', 'description', 'handler'], properties: {
      name: { type: 'string', description: 'lowercase_with_underscores' }, description: { type: 'string', maxLength: 2000 },
      handler: { type: 'string', enum: ['http', 'agent'] }, url: { type: 'string', description: 'For http: the https endpoint.' },
      agent: { type: 'string', description: 'For agent: the handle that answers.' }, input_schema: { type: 'object', description: 'JSON Schema for the inputs.' },
      toolset: { type: 'string', default: 'custom' }, read_only: { type: 'boolean', default: false },
      headers: { type: 'object', description: 'Static headers; ${env:NAME} pulls a server secret.' },
    } },
    run: async (a, ctx) => {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(a.name)) fail(400, 'name must be lowercase letters, digits and underscores.');
      if ((await import('./registry.js')).BUILTIN_NAMES.has(a.name)) fail(409, `${a.name} is a built-in tool.`);
      const config = { timeout_seconds: 30 };
      if (a.handler === 'http') {
        let u; try { u = new URL(a.url); } catch { fail(400, 'url must be an https URL.'); }
        if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|.*\.internal$)/.test(u.hostname)) fail(400, 'url must be a public https URL.');
        Object.assign(config, { url: u.href, method: 'POST', headers: a.headers || {} });
      } else config.agent = (await agents.resolve(a.agent)).handle;
      await q(`insert into tools (name, toolset, description, input_schema, handler, config, read_only, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (name) do update set toolset = excluded.toolset, description = excluded.description, input_schema = excluded.input_schema, handler = excluded.handler,
          config = excluded.config, read_only = excluded.read_only, enabled = true, updated_at = now()`,
        [a.name, a.toolset, a.description, a.input_schema || { type: 'object', properties: {} }, a.handler, config, a.read_only, ctx.agent.id]);
      return { registered: a.name };
    },
  },
  {
    name: 'remove_tool', toolset: 'hyperplex', roles: ['driver', 'host'],
    description: 'Remove a custom tool added with register_tool.',
    input: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    run: async a => { const r = await q(`delete from tools where name = $1`, [a.name]); return { removed: r.rowCount > 0 }; },
  },
];
export { clip };
