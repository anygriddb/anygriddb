-- Identifiers are UUIDv7 (ADR 0003): they sort by creation time, so new
-- rows land at the end of their index instead of anywhere in it.
-- PostgreSQL 17 has no uuidv7(), and AnyGridDB installs no extension: this
-- builds one from gen_random_uuid(), which is core since PostgreSQL 13.
CREATE OR REPLACE FUNCTION ag_uuidv7()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  -- 48 bits of Unix time in milliseconds over the first six bytes of a
  -- random v4 UUID, then version 7 (bits 52 and 53 turn 0100 into 0111).
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;
--> statement-breakpoint
DO $$
DECLARE
  catalog text;
  physical text;
BEGIN
  FOREACH catalog IN ARRAY ARRAY[
    'api_tokens', 'audit_events', 'automation_runs', 'automations',
    'backup_codes', 'bases', 'column_acls', 'comments', 'dashboard_widgets',
    'dashboards', 'data_columns', 'data_tables', 'invitations', 'jobs',
    'login_challenges', 'notifications', 'oauth_states', 'relations',
    'role_bindings', 'row_signatures', 'sessions', 'shares', 'table_acls',
    'users', 'views', 'webauthn_challenges', 'webauthn_credentials',
    'webhook_deliveries', 'webhooks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT ag_uuidv7()', catalog);
  END LOOP;
  -- User tables, in the trash too: a restore brings them back as they were.
  FOR physical IN SELECT physical_name FROM data_tables LOOP
    IF to_regclass(format('%I', physical)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT ag_uuidv7()', physical);
    END IF;
  END LOOP;
END
$$;
