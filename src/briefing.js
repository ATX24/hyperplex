// One call that answers "what's going on?": who is up and doing what, what is waiting on Dhilan,
// recent activity, and what's new on Margins. Built for the driver's check-ins and reflection.
import { all, one } from './db.js';
import * as agents from './agents.js';
import * as artifacts from './artifacts.js';
import * as rpc from './rpc.js';

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function margins() {
  const key = process.env.MARGINS_API_KEY;
  if (!key) return null;
  const base = (process.env.MARGINS_URL || 'https://margins-reader.fly.dev').replace(/\/+$/, '');
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  try {
    const get = p => fetch(base + p, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null);
    const [up, next] = await Promise.all([get(`/api/v1/uploads?since=${encodeURIComponent(since)}&limit=5`), get('/api/v1/what-to-read?limit=2')]);
    return {
      new_from_friends_48h: (up?.uploads || []).map(u => ({ title: u.title, added_by: u.added_by, group: u.in?.name, url: u.url })),
      unread_total: next?.unread_total ?? null,
      top_picks: (next?.recommendations || []).map(r => ({ title: r.title, why: r.why, url: r.url })),
    };
  } catch { return { error: 'Margins didn’t answer in time.' }; }
}

export async function briefing(ctx) {
  const me = ctx.agent;
  const [list, inboxRows, waiting, recent, reviews, m] = await Promise.all([
    agents.list(),
    all(`select m.id, m.kind, m.body, m.created_at, m.thread_id, f.handle as from_handle from messages m left join agents f on f.id = m.from_agent
      where m.to_agent = $1 and m.acked_at is null and m.expires_at > now() order by m.created_at limit 10`, [me.id]),
    all(`select a.handle, a.platform, a.title, a.summary, a.state, a.state_at, a.cwd from agents a
      where a.retired_at is null and a.state in ('waiting', 'blocked') and a.role in ('session', 'agent') and a.state_at > now() - interval '3 days' order by a.state_at desc limit 10`),
    all(`select x.type, x.summary, x.created_at, a.handle from activity x left join agents a on a.id = x.agent_id
      where x.created_at > now() - interval '24 hours' order by x.created_at desc limit 15`),
    artifacts.list(ctx.base, { status: 'ready', limit: 5 }),
    margins(),
  ]);
  const live = list.filter(a => a.status !== 'ended');
  const hosts = (await all(`select id, handle from agents where role = 'host' and retired_at is null`)).map(h => ({ handle: h.handle, connected: rpc.connected(h.id) }));
  return {
    you: me.handle,
    agents: {
      summary: `${live.filter(a => a.status === 'online').length} online, ${live.filter(a => a.state === 'working').length} working, ${waiting.length} waiting or blocked.`,
      list: live.map(a => ({ handle: a.handle, platform: a.platform, status: a.status, state: a.state, doing: clip(a.summary, 240) || null, project: a.project, since: a.state_since })),
    },
    machines: hosts,
    waiting_on_dhilan: [
      ...waiting.map(w => ({ agent: w.handle, platform: w.platform, state: w.state, about: clip(w.summary, 400), since: w.state_at })),
      ...reviews.map(r => ({ artifact: r.title, kind: r.kind, by: r.author, url: r.url })),
    ],
    your_inbox: { unread: inboxRows.length, latest: inboxRows.slice(0, 5).map(x => ({ id: x.id, from: x.from_handle, kind: x.kind, preview: clip(x.body, 200), at: x.created_at })) },
    recent_activity: recent.map(r => ({ agent: r.handle, what: r.summary || r.type, at: r.created_at })),
    ...(m ? { margins: m } : {}),
  };
}
