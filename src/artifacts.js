// Artifacts: plans, diffs, docs, reports and dashboards that agents produce for Dhilan to look at.
// Each has a private review page (/a/<id>?t=<view token>) where it can be approved or sent back;
// the decision goes to the author as a message in the artifact's thread.
import crypto from 'node:crypto';
import { q, one, all, tx } from './db.js';
import { fail } from './http.js';
import { driverId } from './agents.js';
import { send } from './messages.js';

const KINDS = ['plan', 'diff', 'doc', 'report', 'dashboard', 'other'];
const FORMATS = ['markdown', 'diff', 'html', 'text', 'json'];
const STATUSES = ['draft', 'ready', 'approved', 'changes_requested', 'archived'];
const MAX = 2 * 1024 * 1024;

export const artifactUrl = (base, a) => `${base}/a/${a.id}?t=${a.view_token}`;
const summary = (a, base) => ({ id: a.id, title: a.title, kind: a.kind, format: a.format, status: a.status, version: a.version,
  author: a.author_handle ?? null, url: artifactUrl(base, a), thread_id: a.thread_id, created_at: a.created_at, updated_at: a.updated_at });
const SELECT = `select x.*, g.handle as author_handle from artifacts x left join agents g on g.id = x.author_id`;

function check({ title, kind, format, status, content }) {
  if (title !== undefined && !String(title).trim()) fail(400, 'title is required.');
  if (kind !== undefined && !KINDS.includes(kind)) fail(400, `kind must be one of: ${KINDS.join(', ')}.`);
  if (format !== undefined && !FORMATS.includes(format)) fail(400, `format must be one of: ${FORMATS.join(', ')}.`);
  if (status !== undefined && !STATUSES.includes(status)) fail(400, `status must be one of: ${STATUSES.join(', ')}.`);
  if (content !== undefined && Buffer.byteLength(String(content)) > MAX) fail(413, 'content is over 2 MB.');
}

export async function create(author, base, { title, kind = 'doc', format, content, status = 'ready', thread_id, notify = true }) {
  check({ title, kind, format, status, content });
  if (content == null || !String(content).length) fail(400, 'content is required.');
  const fmt = format || (kind === 'diff' ? 'diff' : 'markdown');
  check({ format: fmt });
  const a = await tx(async db => {
    const row = await db.one(`insert into artifacts (title, kind, format, content, status, author_id, thread_id, view_token)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [String(title).slice(0, 200), kind, fmt, String(content), status, author.id, thread_id || crypto.randomUUID(), crypto.randomBytes(18).toString('base64url')]);
    await db.q(`insert into artifact_versions (artifact_id, version, content, author_id) values ($1, 1, $2, $3)`, [row.id, row.content, author.id]);
    await db.q(`insert into activity (agent_id, type, summary, data) values ($1, 'artifact', $2, $3)`, [author.id, `${author.handle} created ${kind} “${row.title}”`, { artifact: row.id }]);
    return row;
  });
  const out = summary({ ...a, author_handle: author.handle }, base);
  // a finished artifact is announced to the driver, unless the driver made it
  const drv = await driverId();
  if (notify && status === 'ready' && drv && drv !== author.id) {
    await send(author, { to: 'driver', kind: 'event', thread_id: a.thread_id, collapse_key: `artifact:${a.id}`,
      body: `${author.handle} shared a ${kind} for review: “${a.title}” ${out.url}`, data: { artifact: out } }).catch(() => {});
  }
  return out;
}

export async function update(agent, base, id, { content, status, title, note }) {
  check({ content, status, title });
  const cur = await get(id);
  if (cur.author_id !== agent.id && agent.id !== await driverId()) fail(403, 'Only the author or the driver can change this artifact.');
  const row = await tx(async db => {
    const r = await db.one(`update artifacts set content = coalesce($2, content), status = coalesce($3, status), title = coalesce($4, title),
        version = version + case when $2::text is not null then 1 else 0 end, updated_at = now() where id = $1 returning *`,
      [cur.id, content != null ? String(content) : null, status || null, title ? String(title).slice(0, 200) : null]);
    if (content != null) await db.q(`insert into artifact_versions (artifact_id, version, content, author_id, note) values ($1, $2, $3, $4, $5)`, [r.id, r.version, r.content, agent.id, note || null]);
    return r;
  });
  return summary({ ...row, author_handle: cur.author_handle }, base);
}

export async function get(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) fail(404, 'Artifact not found.');
  const a = await one(`${SELECT} where x.id = $1`, [id]);
  if (!a) fail(404, 'Artifact not found.');
  return a;
}
export const detail = (a, base) => ({ ...summary(a, base), content: a.content });
export async function list(base, { status, kind, author, limit = 20 } = {}) {
  const rows = await all(`${SELECT} where ($1::text is null or x.status = $1) and ($2::text is null or x.kind = $2) and ($3::text is null or g.handle = $3)
    and x.status <> 'archived' order by x.updated_at desc limit $4`, [status || null, kind || null, author || null, Math.min(Math.max(Number(limit) || 20, 1), 100)]);
  return rows.map(a => summary(a, base));
}

// Review from the artifact page: changes the status and tells the author.
export async function review(id, token, { decision, comment }) {
  const a = await get(id);
  if (!token || !crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(sha(a.view_token)))) fail(404, 'Artifact not found.');
  const status = decision === 'approve' ? 'approved' : decision === 'changes' ? 'changes_requested' : fail(400, 'decision must be approve or changes.');
  await q(`update artifacts set status = $2, updated_at = now() where id = $1`, [a.id, status]);
  const drv = await driverId();
  const reviewer = drv ? await one(`select * from agents where id = $1`, [drv]) : null;
  if (reviewer && a.author_id && a.author_id !== reviewer.id) {
    await send(reviewer, { to: a.author_handle, thread_id: a.thread_id,
      body: `Dhilan ${status === 'approved' ? 'approved' : 'requested changes to'} “${a.title}” (v${a.version}).${comment ? `\n\n${String(comment).slice(0, 8000)}` : ''}` }).catch(() => {});
  }
  return { status };
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------ the review page */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function page(a, token, nonce) {
  const data = JSON.stringify({ format: a.format, content: a.content, raw: `/a/${a.id}/raw?t=${encodeURIComponent(token)}` }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title)} · Hyperplex</title>
<style nonce="${nonce}">
:root { --paper: #f7f6f2; --ink: #1c1f22; --muted: #646a70; --line: #dddbd3; --accent: #2b4c7e; --add: #e6f2e6; --del: #f8e6e4; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --paper: #15171a; --ink: #e7e5df; --muted: #9a9fa5; --line: #2c3035; --accent: #8fb0e6; --add: #1d2d20; --del: #35201e; color-scheme: dark; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 18px 80px; } a { color: var(--accent); }
header { border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 24px; }
.meta { color: var(--muted); font-size: 13px; } h1 { font-size: 26px; line-height: 1.25; margin: 6px 0 8px; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 99px; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; } pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
.diff { padding: 0; } .diff div { white-space: pre; padding: 0 12px; } .diff .a { background: var(--add); } .diff .d { background: var(--del); } .diff .h { color: var(--muted); }
table { border-collapse: collapse; } td, th { border: 1px solid var(--line); padding: 4px 8px; }
iframe { width: 100%; min-height: 70vh; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
form { margin-top: 32px; border-top: 1px solid var(--line); padding-top: 18px; } textarea { width: 100%; min-height: 90px; font: inherit; padding: 8px; background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 6px; }
button { font: inherit; padding: 8px 14px; margin: 8px 8px 0 0; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--paper); cursor: pointer; } button.alt { background: transparent; color: var(--accent); }
.done { color: var(--muted); }
</style></head><body><main>
<header><div class="meta">${esc(a.kind)} by ${esc(a.author_handle || 'an agent')} · v${a.version} · updated ${esc(new Date(a.updated_at).toUTCString())}</div>
<h1>${esc(a.title)}</h1><span class="badge">${esc(a.status.replace('_', ' '))}</span></header>
<article id="content"><noscript><pre>${esc(a.content)}</pre></noscript></article>
<form method="post" action="/a/${a.id}/review"><input type="hidden" name="t" value="${esc(token)}">
<textarea name="comment" placeholder="Comments for ${esc(a.author_handle || 'the author')} (optional)"></textarea>
<button name="decision" value="approve">Approve</button><button class="alt" name="decision" value="changes">Request changes</button></form>
</main>
<script id="data" type="application/json">${data}</script>
<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script>
<script nonce="${nonce}">
const { format, content, raw } = JSON.parse(document.getElementById('data').textContent);
const el = document.getElementById('content');
const pre = t => { const p = document.createElement('pre'); p.textContent = t; return p; };
if (format === 'markdown' && window.marked && window.DOMPurify) el.innerHTML = DOMPurify.sanitize(marked.parse(content));
else if (format === 'diff') { const box = document.createElement('pre'); box.className = 'diff';
  for (const line of content.split('\\n')) { const d = document.createElement('div'); d.textContent = line || ' ';
    d.className = /^(\\+\\+\\+|---|@@|diff )/.test(line) ? 'h' : line[0] === '+' ? 'a' : line[0] === '-' ? 'd' : ''; box.appendChild(d); }
  el.appendChild(box); }
else if (format === 'html') { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = raw; el.appendChild(f); }
else if (format === 'json') { let t = content; try { t = JSON.stringify(JSON.parse(content), null, 2); } catch {} el.appendChild(pre(t)); }
else el.appendChild(pre(content));
</script></body></html>`;
}
// HTML artifacts run in their own sandboxed document: scripts allowed, but no access to this origin
export const rawCsp = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; connect-src 'none'; frame-ancestors 'self'`;
export const pageCsp = nonce => `default-src 'none'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'nonce-${nonce}'; img-src https: data:; frame-src 'self'; child-src blob: 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
