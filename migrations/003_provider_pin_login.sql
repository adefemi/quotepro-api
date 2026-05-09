alter table providers
  add column if not exists pin_hash text,
  add column if not exists pin_set_at timestamptz;
