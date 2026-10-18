// Learning sessions: pi sessions taught with the learn extension (quizzes + a lesson note).
// They live on Dhilan's laptop, so these go through the host; the lesson page is relayed (relay.js).
import * as rpc from '../rpc.js';
import * as relay from '../relay.js';
import { pickHost } from './core.js';

const LESSON = { type: 'string', description: 'Which lesson: words from its topic (e.g. “computer vision”) or its id (first 8 characters are enough).' };

export default [
  {
    name: 'learning_sessions', toolset: 'learning', readOnly: true,
    description: 'Dhilan’s recent learning sessions, newest first: topic, when it was last touched, whether it’s open, and where it left off. Use for “what are my active learning sessions?”.',
    input: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60, default: 14 }, host: { type: 'string' } } },
    examples: [{ say: 'What are some of my active learning sessions?', args: {} }],
    run: async a => rpc.call(await pickHost(a.host), 'learning_list', { days: a.days }),
  },
  {
    name: 'learning_open', toolset: 'learning',
    description: 'Open the interactive lesson page for a learning session and get a private link to send Dhilan. The page shows the lesson note, live answers and quizzes, and an “Ask Pi” box that continues the same session. If the session isn’t running it is started on the laptop. If several lessons match, list them and ask which one.',
    input: { type: 'object', required: ['session'], properties: { session: LESSON, host: { type: 'string' } } },
    examples: [{ say: 'Let’s continue that learning session for computer vision', args: { session: 'computer vision' } }],
    run: async (a, ctx) => {
      const host = await pickHost(a.host);
      const view = await rpc.call(host, 'learning_open', { session: a.session }, { timeout: 50_000 });
      const link = relay.create({ host, port: view.port, token: view.token });
      return { url: `${ctx.base}/r/${link.id}`, expires_at: link.expires_at, topic: view.topic, session: view.session_ref?.slice(0, 8), how: view.how,
        note: 'Send this link to Dhilan only. Anything typed on that page goes into the same pi session.' };
    },
  },
  {
    name: 'learning_read', toolset: 'learning', readOnly: true,
    description: 'Where a learning session left off: its latest exchanges and the end of its lesson note.',
    input: { type: 'object', required: ['session'], properties: { session: LESSON, turns: { type: 'integer', minimum: 1, maximum: 10, default: 2 }, host: { type: 'string' } } },
    run: async a => rpc.call(await pickHost(a.host), 'learning_read', { session: a.session, turns: a.turns }),
  },
];
