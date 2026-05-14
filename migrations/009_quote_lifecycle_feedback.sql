alter table payments
  add column if not exists purpose text not null default 'deposit';

do $$
begin
  alter table payments
    add constraint payments_purpose_check check (purpose in ('deposit', 'balance'));
exception
  when duplicate_object then null;
end $$;

create table if not exists quote_client_feedback (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  provider_id uuid not null references providers(id) on delete cascade,
  type text not null constraint quote_client_feedback_type_check check (type in ('revision_request', 'review')),
  message text not null,
  rating integer constraint quote_client_feedback_rating_check check (rating is null or (rating >= 1 and rating <= 5)),
  created_at timestamptz not null default now()
);

create index if not exists idx_quote_client_feedback_quote_created
  on quote_client_feedback(quote_id, created_at desc);

create index if not exists idx_quote_client_feedback_provider_created
  on quote_client_feedback(provider_id, created_at desc);
