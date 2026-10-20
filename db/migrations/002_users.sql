-- Our own user id, independent of any identity provider. A token only proves
-- "issuer X says subject Y"; `identities` maps that pair to users.id.
create table {{schema}}.users (
  id           uuid        not null primary key,
  display_name text        null,
  email        text        null,
  locale       text        null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table {{schema}}.identities (
  issuer     text        not null,
  subject    text        not null,
  user_id    uuid        not null references {{schema}}.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (issuer, subject)
);

create index identities_user_idx on {{schema}}.identities (user_id);

-- Backfill: until now trips.user_id was the token's `sub` (the Supabase user id).
-- It becomes users.id, and the configured issuer links it to that user, so no
-- trip data moves and existing sessions keep working.
insert into {{schema}}.users (id)
select distinct user_id from {{schema}}.trips;

insert into {{schema}}.identities (issuer, subject, user_id)
select {{auth_issuer}}, id::text, id from {{schema}}.users;

alter table {{schema}}.trips
  add constraint trips_user_id_fkey
  foreign key (user_id) references {{schema}}.users (id) on delete cascade;
