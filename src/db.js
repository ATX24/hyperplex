import fs from 'node:fs/promises';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const q = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0];
export const all = async (text, params) => (await pool.query(text, params)).rows;

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn({ q: (t, p) => c.query(t, p), one: async (t, p) => (await c.query(t, p)).rows[0] });
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate() {
  await q(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

// One dedicated connection listens for new mail; long polls wait on it instead of querying in a loop.
const waiters = new Map();   // agent id -> Set<() => void>
let listener;
export async function listen() {
  listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
  listener.on('notification', n => { for (const wake of waiters.get(n.payload) || []) wake(); });
  listener.on('error', e => { console.error('listener lost, reconnecting', e.message); setTimeout(() => listen().catch(() => {}), 2000); });
  await listener.connect();
  await listener.query('listen inbox');
}
export const notifyInbox = (agentId, client = { q }) => client.q(`select pg_notify('inbox', $1)`, [agentId]);

// Resolves when mail for one of the agent ids arrives, or after ms.
export function waitForMail(agentIds, ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); for (const id of agentIds) waiters.get(id)?.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    for (const id of agentIds) { if (!waiters.has(id)) waiters.set(id, new Set()); waiters.get(id).add(done); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
