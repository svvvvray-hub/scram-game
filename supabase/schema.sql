-- Last Ping: Supabase storage setup.
-- Paste this whole file into Supabase Dashboard > SQL Editor > New query, then click Run. It is safe to run again.
-- The server talks to these tables via the Data API (PostgREST) with the SECRET key (service_role), which bypasses RLS.
-- RLS is on with NO policies and anon/authenticated have no grants, so the publishable/anon key can't read anything
-- (players' social handles stay private).

-- Small JSON blobs: 'stats' (counters, referrers, anonymous device hashes) and 'settings' (brake switch)
create table if not exists public.lastping_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Players' social handles: one row each, so an admin delete (removal request) really deletes the row
create table if not exists public.lastping_socials (
  platform   text not null,
  handle     text not null,             -- lowercase handle (dedup key); data.handle keeps the display form
  data       jsonb not null,            -- {handle, platform, first, last, games, ref}
  updated_at timestamptz not null default now(),
  primary key (platform, handle)
);

-- "Plan the next game" polls: one row per 6-character code, fetched on demand and deleted after expiry
create table if not exists public.lastping_polls (
  code       text primary key,
  data       jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists lastping_polls_expires_at_idx on public.lastping_polls (expires_at);

-- Lock down: RLS on, no policies (deny all for anon/authenticated); only the server's secret key (service_role) has access.
alter table public.lastping_kv      enable row level security;
alter table public.lastping_socials enable row level security;
alter table public.lastping_polls   enable row level security;

revoke all on table public.lastping_kv, public.lastping_socials, public.lastping_polls from anon, authenticated;
-- explicit grants (new Supabase projects no longer expose new tables to the Data API automatically)
grant select, insert, update, delete on table public.lastping_kv, public.lastping_socials, public.lastping_polls to service_role;

-- v18 post-round feedback (rating + two short texts; no names or player ids). Single-line statements:
create table if not exists public.lastping_feedback (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists lastping_feedback_created_at_idx on public.lastping_feedback (created_at);
alter table public.lastping_feedback enable row level security;
revoke all on table public.lastping_feedback from anon, authenticated;
grant select, insert, update, delete on table public.lastping_feedback to service_role;

-- v18 "Ping me for the next game" opt-ins (a social @ or an email; deletable from /admin). Single-line statements:
create table if not exists public.lastping_notify (id text primary key, data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table public.lastping_notify enable row level security;
revoke all on table public.lastping_notify from anon, authenticated;
grant select, insert, update, delete on table public.lastping_notify to service_role;
