alter table quotes
  add column if not exists source_quote_id uuid references quotes(id) on delete set null;

create unique index if not exists idx_quotes_one_open_edit_draft
  on quotes (provider_id, source_quote_id)
  where source_quote_id is not null and status = 'draft';
