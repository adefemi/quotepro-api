alter table quotes
  drop constraint if exists quotes_status_check;

alter table quotes
  add constraint quotes_status_check check (
    status in ('draft', 'sent', 'viewed', 'accepted', 'partial', 'paid', 'expired', 'archived')
  );
