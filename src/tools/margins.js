// Margins (margins-reader.fly.dev): Dhilan's reading list and reading groups. Needs MARGINS_API_KEY.
import { fail } from '../http.js';

const BASE = () => (process.env.MARGINS_URL || 'https://margins-reader.fly.dev').replace(/\/+$/, '') + '/api/v1';
const env = ['MARGINS_API_KEY'];
async function api(_ctx, method, path, { query, body } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])) : '';
  let res;
  try {
    res = await fetch(BASE() + path + qs, { method, headers: { authorization: `Bearer ${process.env.MARGINS_API_KEY}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  } catch { fail(502, 'Couldn’t reach Margins.'); }
  const data = await res.json().catch(() => null);
  if (!res.ok) { const { error, ...rest } = data || {}; fail(res.status >= 500 ? 502 : res.status, error || `Margins answered ${res.status}.`, Object.keys(rest).length ? rest : undefined); }
  return data;
}

// keep what an assistant needs to talk about a document, drop the rest
const brief = d => d && ({
  id: d.id, title: d.title, url: d.url, status: d.status,
  where: [d.in, ...(d.also_in || [])].filter(Boolean).map(p => p.name),
  added_by: d.added_by, added_at: d.added_at, read_minutes: d.read_minutes,
  margin_notes: d.margin_notes, comments: d.comments, read_by_you: d.read_by_you,
  ...(d.note ? { note: d.note } : {}), ...(d.why ? { why: d.why } : {}), ...(d.excerpt ? { excerpt: d.excerpt } : {}),
  ...(d.their_activity ? { their_activity: d.their_activity } : {}),
});
const URL_NOTE = 'Send Dhilan each item’s `url`: it opens the Margins reader, or the original page when the text couldn’t be loaded.';

export default [
  {
    toolset: 'margins', name: 'margins_what_to_read',
    title: 'What should I read?',
    description: `Suggest what Dhilan should read next from their Margins reading list and reading groups: unread first, newest and most discussed ranked higher, each with a reason and an excerpt. Use for “what should I read?”, “something on <topic>”, “something Jessica read”. ${URL_NOTE}`,
    readOnly: true, env,
    input: { type: 'object', properties: {
      topic: { type: 'string', description: 'A subject to search titles and full text for, e.g. “interpretability” or “inference”. Prefixes work (“interp”).', maxLength: 200 },
      group: { type: 'string', description: 'Only from this group (name or id; loose names like “jwlabs” work).' },
      person: { type: 'string', description: 'Only things this person (someone Dhilan shares a group with) added, opened or annotated.' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'How many suggestions.' },
    } },
    examples: [{ say: 'What should I read?', args: {} }, { say: 'I want to read something in interp', args: { topic: 'interpretability' } }, { say: 'Send me something Jessica read', args: { person: 'jessica' } }],
    async run(a, ctx) {
      const r = await api(ctx, 'GET', '/what-to-read', { query: { q: a.topic, group: a.group, person: a.person, limit: a.limit } });
      return { recommendations: r.recommendations.map(brief), unread_total: r.unread_total, ...(r.person ? { person: r.person.name } : {}), ...(r.message ? { message: r.message } : {}) };
    },
  },
  {
    toolset: 'margins', name: 'margins_save',
    title: 'Save a link',
    description: 'Save a link (article, PDF or arXiv paper) to Dhilan’s private Margins reading list, and optionally share it to groups in the same step. Use for “add this to my margins list”, “save this and send it to the JW Labs group”. Adding something already saved doesn’t duplicate it.',
    env,
    input: { type: 'object', required: ['url'], properties: {
      url: { type: 'string', description: 'The link to save.', maxLength: 2000 },
      share_to: { type: 'array', items: { type: 'string' }, description: 'Groups to share it to (names or ids).' },
      title: { type: 'string', description: 'A title, if Dhilan gave one. Otherwise it’s taken from the page.', maxLength: 160 },
      groups_only: { type: 'boolean', default: false, description: 'True to put it only in the groups, not in Dhilan’s private list.' },
    } },
    examples: [{ say: 'Add this to my margins list then distribute to the jwlabs group: https://…', args: { url: 'https://…', share_to: ['jwlabs'] } }],
    async run(a, ctx) {
      const r = await api(ctx, 'POST', '/documents', { body: { url: a.url, title: a.title, share_to: a.share_to, save_to_my_reads: !a.groups_only } });
      return { message: r.message, document: brief(r.document), shared: r.shared.map(s => ({ group: s.group.name, status: s.status })) };
    },
  },
  {
    toolset: 'margins', name: 'margins_share',
    title: 'Share to groups',
    description: 'Share a document Dhilan already has in Margins to one or more groups. Use the `id` from another margins tool.',
    env,
    input: { type: 'object', required: ['document_id', 'groups'], properties: {
      document_id: { type: 'string', description: 'The document’s id.' },
      groups: { type: 'array', items: { type: 'string' }, description: 'Groups to share it to (names or ids).' },
    } },
    async run(a, ctx) {
      const r = await api(ctx, 'POST', `/documents/${encodeURIComponent(a.document_id)}/share`, { body: { groups: a.groups } });
      return { message: r.message, shared: r.shared.map(s => ({ group: s.group.name, status: s.status })) };
    },
  },
  {
    toolset: 'margins', name: 'margins_search',
    title: 'Search the library',
    description: `Search or list everything in Dhilan’s Margins reading list and groups. Use to find a specific piece (“that attention paper”), list a group’s reading, or what someone added. ${URL_NOTE}`,
    readOnly: true, env,
    input: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to find in titles and text.', maxLength: 200 },
      group: { type: 'string', description: 'Only this group. Use “my reads” for Dhilan’s private list.' },
      person: { type: 'string', description: 'Only things this person added.' },
      unread: { type: 'boolean', description: 'True for only unread, false for only already-opened.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    } },
    async run(a, ctx) {
      const r = await api(ctx, 'GET', '/library', { query: { q: a.query, group: a.group, person: a.person, unread: a.unread, limit: a.limit } });
      return { total: r.total, documents: r.documents.map(brief) };
    },
  },
  {
    toolset: 'margins', name: 'margins_person_reading',
    title: 'What is someone reading?',
    description: `What a friend has been reading: things they added, opened, or annotated in groups Dhilan shares with them, newest first. Use for “what is Jessica reading?”. ${URL_NOTE}`,
    readOnly: true, env,
    input: { type: 'object', required: ['person'], properties: {
      person: { type: 'string', description: 'Their name (a first name is enough) or id.' },
      unread_only: { type: 'boolean', default: false, description: 'True for only things Dhilan hasn’t opened yet.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
    } },
    async run(a, ctx) {
      const r = await api(ctx, 'GET', `/people/${encodeURIComponent(a.person)}/reading`, { query: { unread: a.unread_only || undefined, limit: a.limit } });
      return { person: r.person.name, shared_groups: r.shared_groups.map(g => g.name), reading: r.reading.map(brief), ...(r.message ? { message: r.message } : {}) };
    },
  },
  {
    toolset: 'margins', name: 'margins_new_uploads',
    title: 'New in my groups',
    description: 'What friends have added to Dhilan’s groups recently. Pass the `latest` value from the previous call as `since` to get only new ones. Use for a daily check, or “anything new in my groups?”.',
    readOnly: true, env,
    input: { type: 'object', properties: {
      since: { type: 'string', description: 'ISO time; only uploads after it. Omit for the most recent ones.' },
      group: { type: 'string', description: 'Only this group.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    } },
    async run(a, ctx) {
      const r = await api(ctx, 'GET', '/uploads', { query: { since: a.since, group: a.group, limit: a.limit } });
      return { uploads: r.uploads.map(brief), latest: r.latest };
    },
  },
  {
    toolset: 'margins', name: 'margins_mark_read',
    title: 'Mark as read',
    description: 'Mark a document as read, so it stops being suggested. Use when Dhilan says they read it.',
    env,
    input: { type: 'object', required: ['document_id'], properties: { document_id: { type: 'string', description: 'The document’s id.' } } },
    async run(a, ctx) { await api(ctx, 'POST', `/documents/${encodeURIComponent(a.document_id)}/read`); return { ok: true }; },
  },
  {
    toolset: 'margins', name: 'margins_remove',
    title: 'Remove',
    description: 'Remove a document from Dhilan’s private reading list, or from a group if `group` is given (only if Dhilan added it there or owns the group).',
    destructive: true, env,
    input: { type: 'object', required: ['document_id'], properties: {
      document_id: { type: 'string', description: 'The document’s id.' },
      group: { type: 'string', description: 'Remove it from this group instead of from the private list.' },
    } },
    async run(a, ctx) {
      const r = await api(ctx, 'DELETE', `/documents/${encodeURIComponent(a.document_id)}`, { query: { group: a.group } });
      return { message: r.message };
    },
  },
  {
    toolset: 'margins', name: 'margins_groups',
    title: 'Groups and people',
    description: 'List Dhilan’s Margins groups (with members) and the people they share groups with. Use to check a group or person name.',
    readOnly: true, env,
    async run(_, ctx) {
      const [me, people] = await Promise.all([api(ctx, 'GET', '/me'), api(ctx, 'GET', '/people')]);
      return { your_reads: me.your_reads.documents + ' saved', groups: me.groups.map(g => ({ name: g.name, members: g.members, documents: g.documents })),
        people: people.people.map(p => ({ name: p.name, shared_groups: p.shared_groups.map(g => g.name) })) };
    },
  },
];
