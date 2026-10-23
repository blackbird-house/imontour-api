-- Supabase exposes tables in its API schema (public) to the `anon` and `authenticated` roles
-- through its Data API, using the project's anon key, which ships inside the app. This API
-- never uses that path: it connects as the table owner, which bypasses row level security.
-- Enabling RLS with no policies therefore blocks every Data API access and changes nothing
-- for the API. If the API ever connects as a different role, that role needs BYPASSRLS or
-- explicit policies.
alter table {{schema}}.trips             enable row level security;
alter table {{schema}}.users             enable row level security;
alter table {{schema}}.identities        enable row level security;
alter table {{schema}}.schema_migrations enable row level security;

-- Belt and braces: also drop the grants. The roles only exist on Supabase, so this is a no-op elsewhere.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema {{schema}} from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema {{schema}} from authenticated;
  end if;
end
$$;
