create table if not exists provider_push_devices (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  fcm_token text not null,
  platform text not null constraint provider_push_devices_platform_check check (platform in ('ios', 'android')),
  app_version text,
  device_id text,
  last_seen_at timestamptz not null default now(),
  unique (provider_id, fcm_token)
);

create index if not exists idx_provider_push_devices_provider_id on provider_push_devices(provider_id);

create table if not exists provider_notifications (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  quote_id uuid references quotes(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_provider_notifications_provider_created
  on provider_notifications(provider_id, created_at desc);
