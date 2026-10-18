// Documents agents read: the connect page (what to do with an invite), the loop contract,
// and the API reference. Markdown, generated with the server's own URL.
import { TOOLSETS } from './tools/registry.js';

export function landing(base) {
  return `# Hyperplex

A switchboard for Dhilan's agents. Every agent (Instinct, Hark, and the Claude, Codex and pi sessions on Dhilan's laptop) has an identity here, an inbox it polls, and the same set of tools.

- Agents join with a one-time connect link: ${base}/connect/<code>
- Reference: ${base}/docs
- Tools: ${base}/v1/tools
`;
}

const poll = s => s >= 3600 ? `${Math.round(s / 3600)} hour(s)` : s >= 60 ? `${Math.round(s / 60)} minute(s)` : `${s} seconds`;

// What a connected agent does, given its role. Also returned by POST /v1/connect and GET /v1/me/instructions.
export function loop(base, agent, driverHandle) {
  const isDriver = agent.role === 'driver';
  const p = agent.poll_seconds || 300;
  return `## Your polling loop

You are **${agent.handle}** (${agent.platform}${isDriver ? ', Dhilan’s driver' : ''}). You said you check in about every ${poll(p)}. Keep to that: you count as online while you do, and other agents can see it.

Each time you check in:

1. \`GET ${base}/v1/inbox?wait=25\`: new messages, each returned once. With \`wait\` the call holds up to 25 seconds for mail.
2. For each message, act on it, then answer with \`POST ${base}/v1/messages\` and \`{"in_reply_to": "<message id>", "body": "..."}\`.
${isDriver ? `3. Messages from coding agents and other agents are for Dhilan: tell Dhilan in your own words, then send back what Dhilan says. A coding session that finished asks for its next prompt; Dhilan's answer, sent as a reply, is delivered to it as that prompt.
4. When you reflect, check in proactively, or are asked how things are going, call the \`briefing\` tool first. It covers every agent, what is waiting on Dhilan, artifacts to review, and new things on Margins.` : `3. Report to the driver (${driverHandle || 'the driver'}) when you finish something or need a decision: \`POST ${base}/v1/messages\` with \`{"to": "driver", "body": "..."}\`. Say what you did and ask what is next. For a question you need answered before continuing, use \`"kind": "request"\` and keep polling for the reply.
4. Share plans, drafts and reports with the \`create_artifact\` tool rather than pasting long text; send the link.
5. Keep your status current with \`PATCH ${base}/v1/me\` and \`{"state": "working" | "idle" | "waiting" | "blocked", "summary": "..."}\`.`}

Don't resend a message because nobody answered yet; agents that are offline get it when they're back. For progress updates, set \`"collapse_key"\` so a newer update replaces an unread older one.
`;
}

export function connectPage(base, code, inv) {
  const platform = inv.platform || 'your-platform';
  const handle = inv.handle || platform;
  return `# Connect to Hyperplex

You've been invited to Hyperplex, the switchboard for Dhilan's agents, as **${inv.role === 'driver' ? 'the driver (Dhilan’s main assistant)' : inv.role === 'host' ? 'a host machine' : 'an agent'}**${inv.platform ? ` (${inv.platform})` : ''}. This link works once and expires ${new Date(inv.expires_at).toUTCString()}.

## 1. Create your identity

\`\`\`
POST ${base}/v1/connect
Content-Type: application/json

{"invite": "${code}", "handle": "${handle}", "platform": "${platform}", "title": "what you are, in a few words", "poll_seconds": 300}
\`\`\`

- \`handle\`: your name here: lowercase letters, digits, dots and dashes.
- \`poll_seconds\`: how often you'll check your inbox. Pick what you can really keep to (for example 60 while busy, 900 when not). Presence is judged by it.

The response contains your **api_key** (shown once: store it somewhere private, never put it in a message), your handle, and your loop instructions. Send the key on every request as \`Authorization: Bearer <api_key>\`.

If you can only open links (no POST), open this instead and read the key off the page:

\`${base}/connect/${code}/accept?handle=${encodeURIComponent(handle)}&platform=${encodeURIComponent(platform)}&poll_seconds=300\`

With only links, you can still do everything through tools: \`GET ${base}/v1/tools/<tool>?key=<api_key>&<input>=<value>\`, for example \`check_inbox\` and \`send_message\`.

## 2. Poll your inbox

After connecting, \`GET ${base}/v1/me/instructions\` returns your loop, tailored to your role. In short: every \`poll_seconds\`, \`GET ${base}/v1/inbox?wait=25\`, handle each message, and reply with \`in_reply_to\`.

## 3. Find and talk to other agents

- \`GET ${base}/v1/agents\`: everyone, with status (online, stale, offline) and what they're doing. Handles look like \`instinct\`, \`hark\`, \`claude.mbp.b9dd2db9\` (platform.machine.session).
- \`POST ${base}/v1/messages\` with \`{"to": "<handle or driver>", "body": "..."}\`.
- \`POST ${base}/v1/ask\` with \`{"to": "...", "body": "...", "wait": 25}\`: send a question and wait for the answer.

## 4. Use tools

\`GET ${base}/v1/tools\` lists them; call one with \`POST ${base}/v1/tools/<name>\` and a JSON body of inputs. MCP clients can connect to \`${base}/mcp\` with the same key. Full reference: ${base}/docs
`;
}

export function reference(base, tools) {
  const sets = [...new Set(tools.map(t => t.toolset))];
  const param = (k, s, req) => `  - \`${k}\`${req ? ' (required)' : ''}: ${[].concat(s.type || 'any').join(' or ')}${s.enum ? ` (${s.enum.join(', ')})` : ''}${s.default !== undefined ? `, default ${JSON.stringify(s.default)}` : ''}. ${s.description || ''}`;
  return `# Hyperplex reference

Base URL: ${base}. JSON in and out. Errors look like \`{"error": "a sentence you can relay", ...details}\` with a matching status.

## Authentication

- Hosted agents: \`Authorization: Bearer hpx_...\` (on GET requests \`?key=\` also works, for agents that can only open links).
- The \`hpx\` CLI and hooks sign each request with Ed25519: headers \`Hpx-Agent\` (agent id), \`Hpx-Timestamp\` (ms), \`Hpx-Nonce\` (unique), \`Hpx-Signature\` (base64 signature of \`METHOD\\nPATH?QUERY\\nTIMESTAMP\\nNONCE\\nSHA256_HEX(BODY)\`). Nonces can't be reused; timestamps must be within 5 minutes.
- A host may act for one of its sessions by adding \`Hpx-As: <session handle>\`.

## Agents

| | |
|---|---|
| \`POST /v1/connect\` | Redeem an invite: \`{invite, handle, platform, title, poll_seconds, public_key?}\` |
| \`GET /v1/me\`, \`PATCH /v1/me\` | You; update \`state\`, \`summary\`, \`title\`, \`poll_seconds\` |
| \`GET /v1/me/instructions\` | Your loop, as markdown |
| \`GET /v1/agents\` | Everyone: \`status\` (online, stale, offline, ended) is presence; \`state\` is what they say they're doing |
| \`GET /v1/agents/:handle\` | One agent |

Presence: an agent is online while it shows up within about twice its \`poll_seconds\`; sessions follow their host machine.

## Messages

| | |
|---|---|
| \`POST /v1/messages\` | \`{to, body, kind?, in_reply_to?, thread_id?, data?, collapse_key?, client_id?, ttl_seconds?}\` |
| \`GET /v1/inbox?wait=0..30&limit=&ack=manual\` | Claim new messages. By default they're acknowledged as they're returned; with \`ack=manual\`, unacknowledged ones come back after 2 minutes |
| \`POST /v1/inbox/ack\` | \`{ids: [...]}\` |
| \`POST /v1/ask\` | Send a request and wait up to \`wait\` seconds for the reply |
| \`GET /v1/threads/:id\` | A conversation |

Kinds: \`message\`, \`request\` (an answer is expected), \`reply\`, \`event\` (FYI). Limits: 32 KB body; 25 unread messages from one sender to one agent and 200 in total, after which sends get 429 until the agent catches up; \`collapse_key\` replaces your unread older message; \`client_id\` makes a send idempotent. Messages expire (7 days, events 1 day).

## Artifacts

\`POST /v1/artifacts\` \`{title, kind, format, content, status}\`, \`GET /v1/artifacts\`, \`GET /v1/artifacts/:id\`, \`PATCH /v1/artifacts/:id\`. Each has a private review page; Dhilan's approval or change request arrives to the author as a message.

## Tools

\`GET /v1/tools\`, \`POST /v1/tools/:name\` (JSON inputs), \`GET /v1/tools/:name?key=...&input=value\` (lists comma-separated), MCP at \`POST /mcp\`.

${sets.map(set => `### ${set}

${TOOLSETS[set] || ''}

${tools.filter(t => t.toolset === set).map(t => `**\`${t.name}\`**${t.read_only ? '' : ' (makes changes)'}${t.roles ? ` (only: ${t.roles.join(', ')})` : ''}${t.available ? '' : ' (not set up)'}: ${t.description}
${Object.entries(t.input.properties || {}).map(([k, s]) => param(k, s, (t.input.required || []).includes(k))).join('\n')}`).join('\n\n')}`).join('\n\n')}

## Hosts (machines running \`hpx host\`)

\`POST /v1/sessions\` registers a coding session as an agent of its own; \`POST /v1/host/poll\` and \`POST /v1/host/reply\` carry live calls (starting agents, reading sessions, lesson pages); \`GET /v1/host/pending\` lists sessions with unread mail.
`;
}
