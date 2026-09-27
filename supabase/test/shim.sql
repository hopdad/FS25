-- Stand-ins for what a Supabase project provides before any migration runs, so the migrations and
-- their policies can be tested on plain Postgres: the API roles, the `auth` schema with `auth.uid()`,
-- and Supabase's default privileges, which grant every new table and function in `public` to anon
-- and authenticated. That last part matters: a migration that forgets to revoke is caught here.
--
-- A test becomes a user the way PostgREST does it: `set local role authenticated` and the JWT claims
-- in `request.jwt.claims`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create schema auth;

create table auth.users (
  id uuid primary key,
  email text
);

-- As in Supabase: the `sub` claim of the caller's JWT, or null.
create function auth.uid() returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
