// Live calls to host machines (Dhilan's laptop) that can't be reached from the internet.
// The host keeps a long poll open (POST /v1/host/poll); a call is handed to it immediately and
// the host answers with POST /v1/host/reply. This carries actions and lesson-page traffic, which
// are request/response and short-lived, so it stays in memory rather than in the messages table.
import crypto from 'node:crypto';
import { fail } from './http.js';

const POLL_MS = 25_000;
const hosts = new Map();   // host id -> { jobs: [], waiter, lastPoll, info }
const pending = new Map(); // job id -> { resolve, reject, timer, host }

const slot = id => { if (!hosts.has(id)) hosts.set(id, { jobs: [], waiter: null, lastPoll: 0, info: {} }); return hosts.get(id); };
const flush = h => {
  if (!h.waiter || !h.jobs.length) return;
  const w = h.waiter; h.waiter = null; clearTimeout(w.timer); w.resolve(h.jobs.splice(0));
};

export const connected = id => Date.now() - (hosts.get(id)?.lastPoll || 0) < 45_000;
export const hostInfo = id => hosts.get(id)?.info || {};

export function call(host, op, args = {}, { timeout = 30_000 } = {}) {
  if (!connected(host.id)) fail(503, `${host.handle} isn’t connected right now. The laptop has to be on, awake, and running \`hpx host\`.`);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${host.handle} didn’t answer in time.`), { status: 504 })); }, timeout);
    pending.set(id, { resolve, reject, timer, host: host.id });
    const h = slot(host.id);
    h.jobs.push({ id, op, args });
    flush(h);
  });
}

export function poll(hostId, info, onClose) {
  const h = slot(hostId);
  h.lastPoll = Date.now();
  if (info) h.info = info;
  if (h.waiter) { clearTimeout(h.waiter.timer); h.waiter.resolve([]); }
  return new Promise(resolve => {
    const w = { resolve, timer: setTimeout(() => { if (h.waiter === w) h.waiter = null; h.lastPoll = Date.now(); resolve([]); }, POLL_MS) };
    h.waiter = w;
    onClose?.(() => { if (h.waiter === w) { h.waiter = null; clearTimeout(w.timer); resolve([]); } });
    flush(h);
  });
}
// jobs handed to a poll whose connection dropped go back in line
export function requeue(hostId, jobs) {
  const h = slot(hostId);
  h.jobs.unshift(...jobs.filter(j => pending.has(j.id)));
  flush(h);
}
export function reply(hostId, { id, ok, result, error, status, details }) {
  const p = pending.get(id);
  if (!p || p.host !== hostId) return false;
  pending.delete(id); clearTimeout(p.timer);
  slot(hostId).lastPoll = Date.now();
  if (ok) p.resolve(result);
  else p.reject(Object.assign(new Error(error || 'The host couldn’t do that.'), { status: status || 400, details }));
  return true;
}
