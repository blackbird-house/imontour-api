create table {{schema}}.trips (
  user_id        uuid        not null,
  id             uuid        not null,
  name           text        null,
  schema_version int         not null,
  revision       int         not null,
  destinations   jsonb       not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  primary key (user_id, id)
);

create index trips_user_updated_idx
  on {{schema}}.trips (user_id, updated_at desc, id desc);
