-- A write token may create and update rows without deleting them (ADR 0079):
-- the default for AI clients that should not erase records.
alter table api_tokens
  add column allow_delete boolean not null default true;
