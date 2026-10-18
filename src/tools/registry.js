// Tools: built-in ones (tools/*.js) plus ones registered at runtime in the tools table.
// A tool is { name, toolset, description, input (JSON Schema), readOnly, roles?, run(args, ctx) }.
// Registered tools forward to a URL ('http') or to an agent as a request ('agent').
import { q, all } from '../db.js';
import { HttpError, fail } from '../http.js';
import { ask } from '../messages.js';
import core from './core.js';
import margins from './margins.js';
import learning from './learning.js';

const BUILTIN = new Map([...core, ...margins, ...learning].map(t => [t.name, { input: { type: 'object', properties: {} }, readOnly: false, ...t }]));
export const BUILTIN_NAMES = new Set(BUILTIN.keys());
export const TOOLSETS = {
  hyperplex: 'Talk to other agents, see who is up and what they are doing, share artifacts for review, and start or read coding sessions.',
  margins: 'Margins (margins-reader.fly.dev): Dhilan’s private reading list and reading groups with friends.',
  learning: 'Dhilan’s learning sessions (pi lessons with quizzes and a lesson note): list them, see where one left off, and open the interactive lesson page.',
  custom: 'Tools registered at runtime.',
};

const SECRET_REF = /\$\{env:([A-Z0-9_]+)\}/g;
function dbTool(r) {
  return {
    name: r.name, toolset: r.toolset, description: r.description, input: r.input_schema, readOnly: r.read_only, registered: true,
    async run(args, ctx) {
      const timeout = Math.min(Number(r.config.timeout_seconds) || 30, 120) * 1000;
      if (r.handler === 'http') {
        const headers = Object.fromEntries(Object.entries(r.config.headers || {}).map(([k, v]) => [k, String(v).replace(SECRET_REF, (_, n) => process.env[n] || '')]));
        let res;
        try {
          res = await fetch(r.config.url, { method: r.config.method || 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
            body: JSON.stringify({ args, caller: ctx.agent.handle }), signal: AbortSignal.timeout(timeout) });
        } catch { fail(502, `${r.name}: couldn’t reach ${new URL(r.config.url).host}.`); }
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if (!res.ok) fail(res.status >= 500 ? 502 : res.status, data?.error || `${r.name} answered ${res.status}.`);
        return data;
      }
      // agent handler: the agent gets a request message with data { tool, args } and answers in the thread
      const r2 = await ask(ctx.agent, { to: r.config.agent, body: `Tool call: ${r.name}\n${JSON.stringify(args)}`, data: { tool: r.name, args }, wait: Math.min(timeout / 1000, 30) });
      if (!r2.reply) fail(504, `${r.config.agent} hasn’t answered yet. Its reply will arrive in your inbox (thread ${r2.request.thread_id}).`);
      return r2.reply.data ?? r2.reply.body;
    },
  };
}

export async function allTools() {
  const rows = await all(`select * from tools where enabled order by name`);
  const tools = new Map(BUILTIN);
  for (const r of rows) if (!tools.has(r.name)) tools.set(r.name, dbTool(r));
  return tools;
}
export async function getTool(name) {
  if (BUILTIN.has(name)) return BUILTIN.get(name);
  const r = (await all(`select * from tools where name = $1 and enabled`, [name]))[0];
  return r ? dbTool(r) : null;
}
export const available = t => !(t.env || []).some(k => !process.env[k]);
export const allowed = (t, agent) => !t.roles || t.roles.includes(agent.role);

export async function callTool(name, raw, ctx, { fromQuery = false } = {}) {
  const started = Date.now();
  const t = await getTool(name);
  const log = (ok, error) => q(`insert into tool_calls (tool, caller_id, ok, ms, error) values ($1, $2, $3, $4, $5)`, [name, ctx.agent.id, ok, Date.now() - started, error || null]).catch(() => {});
  try {
    if (!t) fail(404, `No tool called “${name}”. See GET /v1/tools.`);
    if (!available(t)) fail(503, `${name} isn’t set up on the server yet (missing ${t.env.filter(k => !process.env[k]).join(', ')}).`);
    if (!allowed(t, ctx.agent)) fail(403, `${name} is only for: ${t.roles.join(', ')}.`);
    const args = prepareArgs(t, raw, { fromQuery });
    let timer;
    const result = await Promise.race([
      t.run(args, ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new HttpError(504, `${name} took too long.`)), 60_000); }),
    ]).finally(() => clearTimeout(timer));
    log(true);
    return result ?? { ok: true };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status || 500;
    if (!(e instanceof HttpError) && !e.status) console.error(`tool ${name} crashed`, e);
    log(false, e.message);
    throw e instanceof HttpError ? e : new HttpError(status, e.status ? e.message : `${name} failed unexpectedly.`, e.details);
  }
}

export function toolView(t) {
  return { name: t.name, toolset: t.toolset, description: t.description, input: t.input, read_only: !!t.readOnly, ...(t.roles ? { roles: t.roles } : {}), available: available(t), ...(t.examples ? { examples: t.examples } : {}) };
}

/* ------------------------------------------------------------ argument checking */
// Query strings arrive as text: "3" becomes 3, "a,b" becomes a list, "true" becomes true.
export function prepareArgs(tool, raw, { fromQuery = false } = {}) {
  const props = tool.input.properties || {};
  const args = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const spec = props[k];
    if (!spec) { if (tool.input.additionalProperties === false) fail(400, `${tool.name} has no input “${k}”. It takes: ${Object.keys(props).join(', ') || 'nothing'}.`); args[k] = v; continue; }
    const c = coerce(k, v, spec, fromQuery);
    if (c !== undefined) args[k] = c;
  }
  for (const k of tool.input.required || []) {
    if (args[k] === undefined || args[k] === '' || (Array.isArray(args[k]) && !args[k].length)) fail(400, `${tool.name} needs “${k}”: ${props[k]?.description || 'required'}`);
  }
  for (const [k, spec] of Object.entries(props)) if (args[k] === undefined && spec.default !== undefined) args[k] = spec.default;
  return args;
}
function coerce(k, v, spec, fromQuery) {
  const types = [].concat(spec.type || []);
  const bad = what => fail(400, `“${k}” should be ${what}.`);
  if (v === null || v === undefined) return undefined;
  if (types.includes('array')) {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [v];
    return list.map(x => spec.items ? coerce(k, x, spec.items, fromQuery) : x);
  }
  if (types.includes('object')) {
    if (typeof v === 'object') return v;
    if (fromQuery && typeof v === 'string') { try { return JSON.parse(v); } catch { bad('a JSON object'); } }
    bad('an object');
  }
  if (types.includes('integer') || types.includes('number')) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n) || (types.includes('integer') && !types.includes('number') && !Number.isInteger(n))) bad(types.includes('integer') ? 'a whole number' : 'a number');
    if (spec.minimum !== undefined && n < spec.minimum) bad(`at least ${spec.minimum}`);
    if (spec.maximum !== undefined && n > spec.maximum) bad(`at most ${spec.maximum}`);
    return n;
  }
  if (types.includes('boolean')) {
    if (typeof v === 'boolean') return v;
    if (/^(true|1|yes)$/i.test(String(v))) return true;
    if (/^(false|0|no)$/i.test(String(v))) return false;
    bad('true or false');
  }
  if (types.includes('string')) {
    if (typeof v !== 'string' && typeof v !== 'number') bad('text');
    const s = String(v);
    if (spec.enum && !spec.enum.includes(s)) bad(`one of: ${spec.enum.join(', ')}`);
    if (spec.maxLength && s.length > spec.maxLength) bad(`at most ${spec.maxLength} characters`);
    return s;
  }
  return v;
}
