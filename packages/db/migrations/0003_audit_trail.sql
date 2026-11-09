SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('insert', 'update', 'delete', 'submit', 'lock', 'unlock', 'sign', 'catalog');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"table_id" uuid,
	"record_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "row_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"meaning" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "require_reason" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_signatures" ADD CONSTRAINT "row_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_table_record" ON "audit_events" USING btree ("table_id","record_id");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "row_signatures_table_record" ON "row_signatures" USING btree ("table_id","record_id");--> statement-breakpoint
CREATE INDEX "row_signatures_signed_at" ON "row_signatures" USING btree ("signed_at" DESC NULLS LAST);--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_events" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "row_signatures" FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Audit immutable';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  reason text;
  grid_id uuid;
  chosen text;
  requested text;
  status_only boolean;
BEGIN
  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  BEGIN
    grid_id := nullif(current_setting('anygrid.table_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF grid_id IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  reason := nullif(current_setting('anygrid.reason', true), '');

  IF TG_OP = 'INSERT' THEN
    IF NEW.ag_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason)
    VALUES (actor, 'insert', grid_id, NEW.id, NULL, to_jsonb(NEW), reason);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.ag_status IN ('locked', 'signed') THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason)
    VALUES (actor, 'delete', grid_id, OLD.id, to_jsonb(OLD), NULL, reason);
    RETURN OLD;
  END IF;

  status_only := (to_jsonb(NEW) - 'ag_status') = (to_jsonb(OLD) - 'ag_status');
  requested := current_setting('anygrid.action', true);

  IF NEW.ag_status IS DISTINCT FROM OLD.ag_status THEN
    IF status_only AND OLD.ag_status = 'draft' AND NEW.ag_status = 'submitted' AND requested = 'submit' THEN
      chosen := 'submit';
    ELSIF status_only AND OLD.ag_status = 'submitted' AND NEW.ag_status = 'locked' AND requested = 'lock' THEN
      chosen := 'lock';
    ELSIF status_only AND OLD.ag_status = 'locked' AND NEW.ag_status = 'signed' AND requested = 'sign' THEN
      chosen := 'sign';
    ELSIF status_only
      AND OLD.ag_status IN ('locked', 'signed')
      AND NEW.ag_status = 'draft'
      AND current_setting('anygrid.unlock', true) = 'on' THEN
      chosen := 'unlock';
    ELSE
      RAISE EXCEPTION 'Invalid status';
    END IF;
  ELSIF OLD.ag_status IN ('locked', 'signed') THEN
    RAISE EXCEPTION 'Row locked';
  ELSE
    chosen := 'update';
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason)
  VALUES (actor, chosen::audit_action, grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_catalog()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
  reason text;
  subject uuid;
  payload jsonb;
  old_payload jsonb;
  new_payload jsonb;
BEGIN
  IF current_setting('anygrid.migrate', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit context required';
  END;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  reason := nullif(current_setting('anygrid.reason', true), '');

  IF TG_OP = 'DELETE' THEN
    payload := to_jsonb(OLD);
    old_payload := payload;
    new_payload := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    payload := to_jsonb(NEW);
    old_payload := to_jsonb(OLD);
    new_payload := payload;
  ELSE
    payload := to_jsonb(NEW);
    old_payload := NULL;
    new_payload := payload;
  END IF;

  IF TG_TABLE_NAME = 'data_tables' THEN
    subject := (payload ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME = 'data_columns' THEN
    subject := (payload ->> 'table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'relations' THEN
    subject := (payload ->> 'to_table_id')::uuid;
  ELSIF TG_TABLE_NAME = 'role_bindings' AND payload ->> 'scope' = 'table' THEN
    subject := (payload ->> 'scope_id')::uuid;
  ELSE
    subject := NULL;
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason)
  VALUES (actor, 'catalog', subject, NULL, old_payload, new_payload, reason);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_audit_immutability
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_tampering();--> statement-breakpoint
CREATE TRIGGER enforce_signature_immutability
  BEFORE UPDATE OR DELETE ON row_signatures
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_tampering();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON data_tables
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON data_columns
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON relations
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON role_bindings
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
DO $$
DECLARE
  rec record;
  constraint_name text;
BEGIN
  FOR rec IN SELECT physical_name FROM data_tables LOOP
    BEGIN
      EXECUTE format(
        'alter table %I add column if not exists ag_status text not null default %L',
        rec.physical_name,
        'draft'
      );
      constraint_name := rec.physical_name || '_ag_status_check';
      EXECUTE format(
        'alter table %I drop constraint if exists %I',
        rec.physical_name,
        constraint_name
      );
      EXECUTE format(
        'alter table %I add constraint %I check (ag_status in (%L, %L, %L, %L))',
        rec.physical_name,
        constraint_name,
        'draft',
        'submitted',
        'locked',
        'signed'
      );
      EXECUTE format('drop trigger if exists audit_record on %I', rec.physical_name);
      EXECUTE format(
        'create trigger audit_record after insert or update or delete on %I for each row execute function audit_record()',
        rec.physical_name
      );
    EXCEPTION
      WHEN undefined_table THEN
        NULL;
    END;
  END LOOP;
END $$;