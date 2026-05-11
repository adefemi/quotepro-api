create extension if not exists "pgcrypto";

create table if not exists providers (
  id uuid primary key default gen_random_uuid(),
  business_name text not null default '',
  service_line text not null default '',
  customer_phone text not null default '',
  has_logo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists provider_sessions (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  token text not null unique,
  channel text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  name text not null,
  phone text not null default '',
  location text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payout_accounts (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  bank_name text not null,
  account_number_last4 text not null,
  account_name text,
  paystack_recipient_code text,
  created_at timestamptz not null default now()
);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  quote_number text not null unique,
  public_slug text not null unique,
  source_quote_id uuid references quotes(id) on delete set null,
  provider_id uuid not null references providers(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  customer_phone text not null default '',
  customer_location text not null default '',
  job_title text not null,
  description text not null,
  prompt text not null default '',
  subtotal_amount integer not null,
  vat_amount integer not null,
  total_amount integer not null,
  deposit_amount integer not null,
  collect_deposit boolean not null default true,
  status text not null default 'draft',
  valid_until date not null,
  sent_at timestamptz,
  accepted_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quotes_status_check check (
    status in ('draft', 'sent', 'viewed', 'accepted', 'partial', 'paid', 'expired', 'archived')
  )
);

create table if not exists quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  title text not null,
  quantity_label text not null,
  unit_amount integer not null,
  total_amount integer not null,
  sort_order integer not null default 0
);

create table if not exists quote_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  kind text not null,
  label text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table if not exists send_attempts (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  channel text not null,
  destination text,
  status text not null default 'recorded',
  provider_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  paystack_reference text unique,
  email text not null default '',
  channel text not null default 'card',
  amount integer not null,
  status text not null default 'pending',
  paid_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_status_check check (status in ('pending', 'initialized', 'paid', 'failed'))
);

create index if not exists idx_provider_sessions_token on provider_sessions(token);
create index if not exists idx_quotes_provider_id on quotes(provider_id);
create index if not exists idx_quotes_public_slug on quotes(public_slug);
create index if not exists idx_quote_events_quote_id on quote_events(quote_id);
create index if not exists idx_payments_quote_id on payments(quote_id);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists providers_set_updated_at on providers;
create trigger providers_set_updated_at
before update on providers
for each row execute function set_updated_at();

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at
before update on customers
for each row execute function set_updated_at();

drop trigger if exists quotes_set_updated_at on quotes;
create trigger quotes_set_updated_at
before update on quotes
for each row execute function set_updated_at();

drop trigger if exists payments_set_updated_at on payments;
create trigger payments_set_updated_at
before update on payments
for each row execute function set_updated_at();
