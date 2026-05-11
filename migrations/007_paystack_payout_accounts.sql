alter table payout_accounts
  add column if not exists bank_code text;

