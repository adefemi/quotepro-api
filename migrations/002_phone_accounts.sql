alter table providers
  add column if not exists account_phone text,
  add column if not exists phone_verified_at timestamptz;

create unique index if not exists idx_providers_account_phone
on providers(account_phone)
where account_phone is not null;

create table if not exists phone_otps (
  phone text primary key,
  code text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
