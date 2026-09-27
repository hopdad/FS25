-- The ledger's tables (docs/HANDOFF.md, "Supabase schema"; docs/LEDGER.md).
--
-- `events` is append-only and idempotent: the bridge inserts each line of the mod's event log once,
-- keyed by (save_id, branch_id, seq), and a repeated insert does nothing. Everything else is derived
-- in views (the next migration), so a reloaded older save can never double-count.
--
-- Access: a save belongs to its owner, who can share it through save_members. The bridge writes with
-- the signed-in player's own session, never the service role, so row-level security applies to every
-- write it makes.

create table public.saves (
  -- The mod's saveId, generated in the game and kept in the savegame's farmLink.xml.
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text,
  map text,
  mod_version text,
  created_at timestamptz not null default now(),
  last_synced_at timestamptz
);

create table public.save_members (
  save_id uuid not null references public.saves (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- A member writes (a member hosting the game runs the bridge); a viewer only reads.
  role text not null check (role in ('member', 'viewer')),
  primary key (save_id, user_id)
);

create index save_members_user on public.save_members (user_id);

-- A branch is one line of play. Reloading an older savegame starts a new branch whose events
-- continue from the savegame's seq (fork_seq) on its parent (PLAN_REVIEW.md F2).
create table public.save_branches (
  save_id uuid not null references public.saves (id) on delete cascade,
  branch_id uuid not null,
  parent_branch_id uuid,
  fork_seq bigint check (fork_seq >= 0),
  -- When the newest session on this branch started; the active branch is the latest one played.
  last_session_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (save_id, branch_id),
  check ((parent_branch_id is null) = (fork_seq is null)),
  check (parent_branch_id is distinct from branch_id)
);

create table public.events (
  save_id uuid not null,
  branch_id uuid not null,
  seq bigint not null check (seq >= 1),
  type text not null check (type in (
    'money', 'harvest', 'field_work', 'vehicle_added', 'vehicle_removed', 'vehicle_hours',
    'worker_start', 'worker_stop', 'prices', 'day_rollover', 'session'
  )),
  farm_id integer not null check (farm_id between 0 and 255),
  -- FS25's uniqueUserId of the player who caused it; null for AI and system events.
  user_id text,
  -- environment.currentMonotonicDay, the minute of that day, and environment.currentYear: the
  -- season field P&L and worker downtime are reported by (PLAN_REVIEW.md C1).
  day integer not null check (day >= 0),
  minute integer not null check (minute between 0 and 1439),
  year integer not null check (year >= 0),
  real_ts timestamptz not null,
  data jsonb not null,
  v smallint not null default 1,
  primary key (save_id, branch_id, seq),
  foreign key (save_id, branch_id) references public.save_branches (save_id, branch_id) on delete cascade
);

create index events_save_type_day on public.events (save_id, type, day);

-- One snapshot of the farms per game day, taken by the bridge from live_farm.json (PLAN_REVIEW.md F3).
create table public.snapshots (
  save_id uuid not null,
  branch_id uuid not null,
  day integer not null check (day >= 0),
  payload jsonb not null,
  taken_at timestamptz not null default now(),
  primary key (save_id, branch_id, day),
  foreign key (save_id, branch_id) references public.save_branches (save_id, branch_id) on delete cascade
);

-- Branch bookkeeping ------------------------------------------------------------------------------

-- Every event creates its branch on first sight, and a session event records where the branch forked
-- and when it was last played. Idempotent, so a repeated insert changes nothing. It runs as the
-- caller, so its writes pass the same row-level security as the event itself.
create function public.events_track_branch() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.save_branches (save_id, branch_id)
  values (new.save_id, new.branch_id)
  on conflict (save_id, branch_id) do nothing;

  if new.type = 'session' then
    update public.save_branches b
    set last_session_at = greatest(b.last_session_at, new.real_ts)
    where b.save_id = new.save_id and b.branch_id = new.branch_id;

    -- A branch forks once; the first session that says where wins.
    if new.data ->> 'parentBranchId' is not null and new.data ->> 'forkSeq' is not null then
      update public.save_branches b
      set
        parent_branch_id = (new.data ->> 'parentBranchId')::uuid,
        fork_seq = (new.data ->> 'forkSeq')::bigint
      where b.save_id = new.save_id and b.branch_id = new.branch_id and b.parent_branch_id is null;
    end if;
  end if;
  return new;
end;
$$;

create trigger events_track_branch
before insert on public.events
for each row execute function public.events_track_branch();

-- A snapshot can arrive before its branch's first event.
create function public.snapshots_track_branch() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.save_branches (save_id, branch_id)
  values (new.save_id, new.branch_id)
  on conflict (save_id, branch_id) do nothing;
  return new;
end;
$$;

create trigger snapshots_track_branch
before insert on public.snapshots
for each row execute function public.snapshots_track_branch();

-- Access ------------------------------------------------------------------------------------------

-- The saves the caller can see, with their role on each: 'owner', 'member' or 'viewer'. Security
-- definer, because the policies on saves and save_members would otherwise read each other and
-- recurse. Policies use it as `save_id in (select ...)`, which Postgres runs once per statement
-- rather than once per row. The web app can call it to list the caller's saves.
create function public.my_saves() returns table (save_id uuid, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, 'owner' from public.saves s where s.owner_id = (select auth.uid())
  union all
  select m.save_id, m.role
  from public.save_members m
  join public.saves s on s.id = m.save_id
  where m.user_id = (select auth.uid()) and s.owner_id <> m.user_id;
$$;

alter table public.saves enable row level security;
alter table public.save_members enable row level security;
alter table public.save_branches enable row level security;
alter table public.events enable row level security;
alter table public.snapshots enable row level security;

create policy saves_read on public.saves
  for select to authenticated
  using (id in (select s.save_id from public.my_saves() s));
create policy saves_create on public.saves
  for insert to authenticated
  with check (owner_id = (select auth.uid()));
-- Owners and members keep the save's name and sync time current; the column grants below keep
-- everyone off id and owner_id.
create policy saves_update on public.saves
  for update to authenticated
  using (id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')))
  with check (id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));
create policy saves_delete on public.saves
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy members_read on public.save_members
  for select to authenticated
  using (save_id in (select s.save_id from public.my_saves() s));
create policy members_manage on public.save_members
  for all to authenticated
  using (save_id in (select s.save_id from public.my_saves() s where s.role = 'owner'))
  with check (save_id in (select s.save_id from public.my_saves() s where s.role = 'owner'));
create policy members_leave on public.save_members
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy branches_read on public.save_branches
  for select to authenticated
  using (save_id in (select s.save_id from public.my_saves() s));
create policy branches_create on public.save_branches
  for insert to authenticated
  with check (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));
create policy branches_update on public.save_branches
  for update to authenticated
  using (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')))
  with check (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));

create policy events_read on public.events
  for select to authenticated
  using (save_id in (select s.save_id from public.my_saves() s));
create policy events_create on public.events
  for insert to authenticated
  with check (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));

create policy snapshots_read on public.snapshots
  for select to authenticated
  using (save_id in (select s.save_id from public.my_saves() s));
create policy snapshots_create on public.snapshots
  for insert to authenticated
  with check (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));
create policy snapshots_update on public.snapshots
  for update to authenticated
  using (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')))
  with check (save_id in (select s.save_id from public.my_saves() s where s.role in ('owner', 'member')));

-- Privileges. Supabase grants every new table and function in `public` to anon and authenticated by
-- default, so each object starts from nothing and gets exactly what it needs.
revoke all on public.saves, public.save_members, public.save_branches, public.events, public.snapshots
  from public, anon, authenticated;
revoke all on function public.my_saves() from public, anon, authenticated;
revoke all on function public.events_track_branch() from public, anon, authenticated;
revoke all on function public.snapshots_track_branch() from public, anon, authenticated;

grant execute on function public.my_saves() to authenticated;
grant select, insert, delete on public.saves to authenticated;
grant update (name, map, mod_version, last_synced_at) on public.saves to authenticated;
grant select, insert, update, delete on public.save_members to authenticated;
grant select, insert, update on public.save_branches to authenticated;
-- Append-only: no update or delete, and a repeated insert is `on conflict do nothing`.
grant select, insert on public.events to authenticated;
grant select, insert, update on public.snapshots to authenticated;
