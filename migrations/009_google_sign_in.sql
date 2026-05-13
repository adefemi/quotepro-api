alter table providers
  add column if not exists google_sub text,
  add column if not exists google_email text,
  add column if not exists google_picture_url text;

create unique index if not exists idx_providers_google_sub
on providers(google_sub)
where google_sub is not null;

create unique index if not exists idx_providers_google_email_lower
on providers(lower(google_email))
where google_email is not null;
