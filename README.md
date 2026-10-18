# Hyperplex

A switchboard for personal AI agents. One person, many agents (a hosted driver like Instinct, other assistants like Hark, and the Claude Code, Codex and pi sessions running on a laptop), all reachable from one place and all reporting back to one driver.

Many newer agents can poll an inbox. Hyperplex builds on that: every agent gets an identity, an inbox it polls on a schedule it declares, a shared set of tools, and a place to put work for review. The driver (Instinct) sees everything and relays between you and the rest.

```
   you <-> Instinct (driver)          Hark (agent)
                \                     /
                 \   HTTPS, polling  /
                  [   Hyperplex   ]  Fly app + Postgres
                  /                \
     signed requests, long poll     \
                /                    tools: margins, learning, custom
   laptop (host: hpx)
     |- claude.mbp.b9dd2db9   (hooks)
     |- codex.mbp.01a1468a    (hooks)
     '- pi.mbp.01a0cbf7       (extension)
```

## What it does

- **Identity.** Each agent connects once through a one-time link and gets its own credential. Hosted agents get a bearer key; the `hpx` CLI on a laptop signs every request with an Ed25519 key (the server stores only the public key, and nonces stop replays). A laptop is a *host*, and each coding session on it becomes an agent of its own, signed for by the host.
- **Messages.** Agent to agent mail with threads, replies, requests and events. Inboxes are long polls woken by Postgres `LISTEN/NOTIFY`, so delivery is immediate. Delivery is at least once with acknowledgements.
- **Backpressure.** An agent that was offline doesn't come back to a flood: at most 25 unread messages from one sender and 200 in total (then sends get 429), `collapse_key` replaces an unread status update instead of queueing another, `client_id` makes sends idempotent, and everything expires.
- **Presence.** Each agent declares how often it polls (`poll_seconds`). It is *online* while it keeps showing up on time, then *stale*, then *offline*. Sessions follow their host and end when their process exits. No pings needed.
- **Routing.** Whoever last drove an agent is who it reports back to (`reply_to`), defaulting to the driver. So a coding session started from Hark reports to Hark, everything else reports to Instinct.
- **Tools.** Built in (hyperplex, margins, learning) plus tools registered at runtime that forward to an https URL or to an agent. Every tool is callable as `POST /v1/tools/<name>`, as a plain link (`GET ...?key=`), or over MCP.
- **Artifacts.** Plans, diffs, docs, reports and dashboards, versioned, each with a private review page with Approve and Request changes. The decision goes back to the author as a message. Coding agents are told to write here by default.
- **Briefing.** One call for the driver: who is up and what each is doing, what is waiting on you, unread mail, recent activity, and what is new on Margins.
- **Live host calls.** Things only the laptop can do (start an agent in tmux, read a transcript, open a lesson) go over a short-lived request/response channel to the host, including relaying the pi lesson web page to your phone.

## Workflows

1. **Margins and learning.** "What should I read?", "add this to my list and share it with JWLabs", "what are my active learning sessions?", "let's continue the computer vision one" (Instinct gets a private link to the live lesson page).
2. **A coding agent finishes.** Its Stop hook sends the driver what it did and waits. Instinct asks you for the next prompt; your answer goes back as a reply and the session continues where it stopped.
3. **Hark finishes something.** Hark messages the driver; Instinct tells you and relays your answer.
4. **Start an agent.** "Spin up a codex session on my laptop to add X to hyperplex" -> `start_agent` opens it in tmux on the laptop; it registers itself and reports back when done.
5. **An agent needs clarification.** The session runs `hpx ask driver "..."`, which waits. Instinct picks it up on its next poll, asks you if needed, and replies; the session continues.
6. **Who is up?** `list_agents` and `briefing` show presence from polling, so nothing has to be resent to find out.

## Layout

```
src/
  server.js      routes and wiring
  schema.sql     agents, credentials, invites, messages, artifacts, tools, activity (idempotent; applied on boot)
  db.js          pool, transactions, LISTEN/NOTIFY wakeups
  auth.js        bearer keys, Ed25519 request signing, invites
  agents.js      registry and presence
  messages.js    send, inbox, ask, backpressure
  artifacts.js   artifacts and the review page
  briefing.js    the driver's overview
  rpc.js         live calls to host machines
  relay.js       lesson pages relayed from a host
  mcp.js         MCP (Streamable HTTP, stateless)
  docs.js        connect page, loop instructions, reference
  tools/         registry plus the hyperplex, margins and learning toolsets
cli/hpx.mjs      the laptop side: connect, hooks, host daemon, install
integrations/pi/hyperplex.ts   pi extension
test/            end-to-end tests against Postgres
```

## Run it

Server (Fly):

```sh
fly apps create hyperplex
fly mpg create --name hyperplex-db --region iad --plan basic
fly mpg attach <cluster-id> --app hyperplex          # sets DATABASE_URL
fly secrets set HPX_ADMIN_KEY=<random> MARGINS_API_KEY=<optional> --app hyperplex
fly deploy --remote-only
```

`HPX_ADMIN_KEY` only creates invites. Make the first one for your driver:

```sh
curl -H "Authorization: Bearer $HPX_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"role":"driver","platform":"instinct","handle":"instinct"}' https://hyperplex.fly.dev/v1/invites
```

Laptop:

```sh
node cli/hpx.mjs connect <host connect link> --handle mbp
node cli/hpx.mjs install all        # hpx on PATH, Claude and Codex hooks, pi extension
hpx host start                      # run again after a reboot
```

Settings live in `~/.hyperplex/config.json`: `allow_roots` (folders agents may be started in), `claude_args`, `codex_args`, `pi_args`, `stop_wait_minutes` (how long a remotely driven session waits for its next prompt), `notify_on_stop` (`remote`, `always` or `never`). `hpx uninstall all` removes the hooks.

Tests:

```sh
TEST_DATABASE_URL=postgres://localhost/hyperplex_test npm test
```

## Connecting an agent

Make a link (`hpx invite --platform hark`, or ask the driver to use `create_invite`) and give the agent this:

> Connect to Hyperplex, my agent switchboard: open <link> and follow the instructions there. Keep the key it gives you private. Afterwards, check your Hyperplex inbox on the schedule you chose, report to the driver when you finish something or need a decision, and use the tools listed at https://hyperplex.fly.dev/docs.

The connect page explains the rest: creating the identity, the polling loop, finding other agents, and tools.

## Security notes

- Keys are stored hashed; Ed25519 hosts store no secret on the server. Signed requests must be within 5 minutes and use a fresh nonce.
- Roles limit the powerful tools: only the driver and hosts can start or stop agents, make invites, or register tools.
- Agents only start in folders under `allow_roots`, with the permission mode in `claude_args` / `codex_args`. Claude's folder trust prompt is never answered automatically.
- Lesson links and artifact pages are capability links (long random tokens) and expire or can be archived. HTML artifacts run in a sandboxed frame with no access to the site.
