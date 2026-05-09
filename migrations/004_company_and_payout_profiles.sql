create table if not exists provider_companies (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  business_name text not null,
  service_line text not null,
  customer_phone text not null default '',
  logo_url text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into provider_companies (
  provider_id,
  business_name,
  service_line,
  customer_phone,
  is_default,
  created_at,
  updated_at
)
select
  p.id,
  case when p.business_name = '' then 'My Company' else p.business_name end,
  case when p.service_line = '' then 'General services' else p.service_line end,
  p.customer_phone,
  true,
  p.created_at,
  p.updated_at
from providers p
where not exists (
  select 1
  from provider_companies pc
  where pc.provider_id = p.id
);

create unique index if not exists idx_provider_companies_default
on provider_companies(provider_id)
where is_default;

create index if not exists idx_provider_companies_provider_id
on provider_companies(provider_id);

alter table quotes
  add column if not exists company_id uuid references provider_companies(id) on delete set null;

update quotes q
set company_id = pc.id
from provider_companies pc
where q.company_id is null
  and pc.provider_id = q.provider_id
  and pc.is_default;

create index if not exists idx_quotes_company_id on quotes(company_id);

alter table payout_accounts
  add column if not exists is_default boolean not null default false;

with ranked as (
  select id,
    row_number() over (partition by provider_id order by created_at desc, id desc) as rn
  from payout_accounts
)
update payout_accounts pa
set is_default = ranked.rn = 1
from ranked
where pa.id = ranked.id;

create unique index if not exists idx_payout_accounts_default
on payout_accounts(provider_id)
where is_default;

drop trigger if exists provider_companies_set_updated_at on provider_companies;
create trigger provider_companies_set_updated_at
before update on provider_companies
for each row execute function set_updated_at();
