// Lesson pages (the pi learn web app) served from Dhilan's laptop, reachable from a phone.
// learning_open creates /r/<id>. Opening it sets a cookie for this browser; from then on its
// requests for /, /assets/* and /api/* are relayed through the host to that lesson's local server.
// The link names the session, not one run of its page, so it survives pi restarts; the host signs in
// to whichever page that session is serving now.
import crypto from 'node:crypto';
import { readBody } from './http.js';
import * as rpc from './rpc.js';

const TTL_MS = 12 * 3600e3;
const links = new Map();   // id -> { host, session, expires }

export function create({ host, session }) {
  const now = Date.now();
  for (const [id, l] of links) if (l.expires < now) links.delete(id);
  const id = crypto.randomBytes(24).toString('base64url');
  links.set(id, { host, session, expires: now + TTL_MS });
  return { id, expires_at: new Date(now + TTL_MS).toISOString() };
}
const get = id => { const l = id && links.get(id); return l && l.expires > Date.now() ? l : null; };
const cookieOf = req => /(?:^|;\s*)hpx_relay=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '')?.[1];
const lessonPath = p => p === '/' || p === '/index.html' || p.startsWith('/assets/') || p.startsWith('/api/') || p === '/favicon.ico';

// Returns true when it handled the request.
export async function handle(req, res, url) {
  const open = /^\/r\/([A-Za-z0-9_-]{20,})$/.exec(url.pathname);
  if (open && req.method === 'GET') {
    const link = get(open[1]);
    if (!link) { res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }); res.end('This lesson link has expired. Ask for a new one.\n'); return true; }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
    res.writeHead(302, { location: '/', 'set-cookie': `hpx_relay=${open[1]}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=43200`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  }
  const link = get(cookieOf(req));
  if (!link || !lessonPath(url.pathname)) return false;
  const body = req.method === 'POST' ? (await readBody(req, 64 * 1024)).toString('base64') : undefined;
  const headers = Object.fromEntries(['accept', 'content-type', 'user-agent'].filter(h => req.headers[h]).map(h => [h, req.headers[h]]));
  // same-origin check for writes happens here; the host signs in to the lesson page itself
  if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Same-origin requests only.\n'); return true;
  }
  const r = await rpc.call(link.host, 'http', { session: link.session, method: req.method, path: url.pathname + url.search, headers, body }, { timeout: 30_000 })
    .catch(e => ({ status: e.status === 503 ? 503 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`${e.message}\n`).toString('base64') }));
  const keep = ['content-type', 'set-cookie', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'etag'];
  res.writeHead(r.status, Object.fromEntries(keep.filter(h => r.headers?.[h]).map(h => [h, r.headers[h]])));
  res.end(Buffer.from(r.body || '', 'base64'));
  return true;
}
