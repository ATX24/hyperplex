// Minimal HTTP plumbing: a router, typed errors, body parsing and responses.

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const fail = (status, message, details) => { throw new HttpError(status, message, details); };

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
export function send(res, status, body, type) {
  if (res.headersSent) return;
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY, 'content-type': type || (isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8') });
  res.end(isText ? body : JSON.stringify(body));
}

export async function readBody(req, limit = 256 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) fail(413, 'Request body is too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  req.rawBody = raw;
  const s = raw.toString('utf8').trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { fail(400, 'The body must be JSON.'); }
}

// Routes like 'GET /v1/agents/:handle'. Handlers get (req, res, params) and may return a value to send as JSON.
export function router() {
  const routes = [];
  const add = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: (p, ...h) => add('GET', p, ...h), post: (p, ...h) => add('POST', p, ...h),
    patch: (p, ...h) => add('PATCH', p, ...h), put: (p, ...h) => add('PUT', p, ...h), delete: (p, ...h) => add('DELETE', p, ...h),
    match(method, path) {
      let allowed = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed = true; continue; }
        return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return allowed ? { notAllowed: true } : null;
    },
  };
}
