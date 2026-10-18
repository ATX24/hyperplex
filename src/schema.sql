-- Hyperplex schema. Idempotent: applied on every boot.

-- Every participant: hosted assistants (instinct, hark), machines (hosts), and the
-- coding sessions those machines run (claude, codex, pi). Sessions belong to a host.
create table if not exists agents (
  id            uuid primary key default gen_random_uuid(),
  handle        text not null unique check (handle ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  platform      text not null,
  role          text not null default 'agent' check (role in ('driver', 'agent', 'host', 'session')),
  title         text,
  host_id       uuid references agents on delete cascade,
  session_ref   text,                       -- the platform's own session id
  cwd           text,
  poll_seconds  int check (poll_seconds between 1 and 86400),
  state         text not null default 'idle' check (state in ('working', 'idle', 'waiting', 'blocked', 'ended')),
  summary       text,
  state_at      timestamptz not null default now(),
  reply_to      uuid references agents on delete set null,   -- who this agent reports back to (default: driver)
  meta          jsonb not null default '{}',
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  retired_at    timestamptz
);
create unique index if not exists agents_session on agents (host_id, platform, session_ref) where session_ref is not null;
create index if not exists agents_host on agents (host_id);

-- How an agent proves who it is: a bearer key (hosted assistants) or an Ed25519 public key (CLI and hooks).
create table if not exists credentials (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references agents on delete cascade,
  kind          text not null check (kind in ('key', 'ed25519')),
  key_hash      text unique,                -- sha256 of a bearer key
  public_key    text,                       -- base64 SPKI DER for ed25519
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  check ((kind = 'key' and key_hash is not null) or (kind = 'ed25519' and public_key is not null))
);
create index if not exists credentials_agent on credentials (agent_id);

-- Signed requests carry a nonce; remembering them for a while stops replays.
create table if not exists nonces (
  nonce      text primary key,
  seen_at    timestamptz not null default now()
);

-- One-time connect links. The code itself is never stored, only its hash.
create table if not exists invites (
  code_hash    text primary key,
  role         text not null check (role in ('driver', 'agent', 'host')),
  platform     text,
  handle       text,
  note         text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_by      uuid references agents on delete set null
);

-- Agent to agent mail. thread_id groups a conversation; collapse_key lets a newer
-- pending message replace an older one (status updates) instead of piling up.
create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null,
  in_reply_to   uuid references messages on delete set null,
  from_agent    uuid references agents on delete set null,
  to_agent      uuid not null references agents on delete cascade,
  kind          text not null default 'message' check (kind in ('message', 'request', 'reply', 'event')),
  body          text not null,
  data          jsonb,
  collapse_key  text,
  client_id     text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  acked_at      timestamptz,
  expires_at    timestamptz not null
);
create unique index if not exists messages_client on messages (from_agent, client_id) where client_id is not null;
create index if not exists messages_inbox on messages (to_agent, created_at) where acked_at is null;
create index if not exists messages_thread on messages (thread_id, created_at);

-- Plans, diffs, docs, dashboards: anything an agent wants a person to look at.
create table if not exists artifacts (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  kind         text not null default 'doc' check (kind in ('plan', 'diff', 'doc', 'report', 'dashboard', 'other')),
  format       text not null default 'markdown' check (format in ('markdown', 'diff', 'html', 'text', 'json')),
  content      text not null,
  status       text not null default 'draft' check (status in ('draft', 'ready', 'approved', 'changes_requested', 'archived')),
  version      int not null default 1,
  author_id    uuid references agents on delete set null,
  thread_id    uuid,
  view_token   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists artifacts_recent on artifacts (updated_at desc);
create table if not exists artifact_versions (
  artifact_id  uuid not null references artifacts on delete cascade,
  version      int not null,
  content      text not null,
  author_id    uuid references agents on delete set null,
  note         text,
  created_at   timestamptz not null default now(),
  primary key (artifact_id, version)
);

-- Tools registered at runtime. Built-in tools live in code; these forward to a URL
-- ('http') or to an agent's inbox as a request ('agent').
create table if not exists tools (
  name          text primary key check (name ~ '^[a-z][a-z0-9_]{1,63}$'),
  toolset       text not null default 'custom',
  description   text not null,
  input_schema  jsonb not null default '{"type":"object","properties":{}}',
  handler       text not null check (handler in ('http', 'agent')),
  config        jsonb not null default '{}',
  read_only     boolean not null default false,
  enabled       boolean not null default true,
  created_by    uuid references agents on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists tool_calls (
  id          bigserial primary key,
  tool        text not null,
  caller_id   uuid references agents on delete set null,
  ok          boolean not null,
  ms          int not null,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists tool_calls_recent on tool_calls (created_at desc);

-- What happened, for briefings: state changes, finished turns, new artifacts.
create table if not exists activity (
  id          bigserial primary key,
  agent_id    uuid references agents on delete cascade,
  type        text not null,
  summary     text,
  data        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists activity_recent on activity (created_at desc);
create index if not exists activity_agent on activity (agent_id, created_at desc);

create table if not exists settings (
  key    text primary key,
  value  jsonb not null
);
