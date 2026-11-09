SELECT set_config('anygrid.migrate', 'on', true);--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'datetime';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'multi_select';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'url';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'phone';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'rating';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'duration';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'user';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'created_time';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'last_modified_time';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'created_by';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'last_modified_by';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE 'autonumber';--> statement-breakpoint
ALTER TYPE "public"."view_type" ADD VALUE 'timeline';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'commenter';--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "label" text;--> statement-breakpoint
UPDATE "data_columns" SET "label" = "name" WHERE "label" IS NULL;--> statement-breakpoint
ALTER TABLE "data_columns" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "is_unique" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN "inverse_column_id" uuid;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_table_row" ON "comments" USING btree ("table_id","row_id");--> statement-breakpoint
CREATE INDEX "views_table" ON "views" USING btree ("table_id");--> statement-breakpoint
UPDATE "data_columns" c SET "position" = s.rn
FROM (SELECT id, (row_number() OVER (PARTITION BY table_id ORDER BY name) - 1)::int AS rn FROM data_columns) s
WHERE c.id = s.id;--> statement-breakpoint
UPDATE "data_columns" SET "is_primary" = true
WHERE id IN (
  SELECT DISTINCT ON (table_id) id FROM data_columns
  WHERE field_type IN ('text', 'long_text', 'single_select', 'number', 'date', 'formula')
  ORDER BY table_id, (field_type <> 'text'), position
);--> statement-breakpoint
UPDATE "data_tables" t SET "position" = s.rn
FROM (SELECT id, (row_number() OVER (PARTITION BY base_id ORDER BY created_at, name) - 1)::int AS rn FROM data_tables) s
WHERE t.id = s.id;--> statement-breakpoint
UPDATE "views" v SET "position" = s.rn
FROM (SELECT id, (row_number() OVER (PARTITION BY table_id ORDER BY created_at, name) - 1)::int AS rn FROM views) s
WHERE v.id = s.id;--> statement-breakpoint
CREATE UNIQUE INDEX "data_columns_table_primary" ON "data_columns" ("table_id") WHERE "is_primary";--> statement-breakpoint
CREATE OR REPLACE FUNCTION ag_try_numeric(value text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF value IS NULL OR btrim(value) !~ '^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d{1,4})?$' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(value)::numeric;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ag_try_date(value text)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF value IS NULL OR btrim(value) !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN left(btrim(value), 10)::date;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ag_try_timestamptz(value text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF value IS NULL OR btrim(value) !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(value)::timestamptz;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ag_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor uuid;
BEGIN
  BEGIN
    actor := nullif(current_setting('anygrid.user_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      actor := NULL;
  END;
  IF TG_OP = 'INSERT' THEN
    NEW.ag_created_by := coalesce(NEW.ag_created_by, actor);
    NEW.ag_updated_by := actor;
    NEW.ag_updated_at := now();
    RETURN NEW;
  END IF;
  NEW.ag_seq := OLD.ag_seq;
  NEW.ag_created_at := OLD.ag_created_at;
  NEW.ag_created_by := OLD.ag_created_by;
  IF (to_jsonb(NEW) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by')
     IS DISTINCT FROM (to_jsonb(OLD) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by') THEN
    NEW.ag_updated_at := now();
    NEW.ag_updated_by := actor;
  ELSE
    NEW.ag_updated_at := OLD.ag_updated_at;
    NEW.ag_updated_by := OLD.ag_updated_by;
  END IF;
  RETURN NEW;
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
  origin text;
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
  origin := left(nullif(current_setting('anygrid.source', true), ''), 80);

  IF TG_OP = 'INSERT' THEN
    IF NEW.ag_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'insert', grid_id, NEW.id, NULL, to_jsonb(NEW), reason, origin);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.ag_status IN ('locked', 'signed') THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'delete', grid_id, OLD.id, to_jsonb(OLD), NULL, reason, origin);
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

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
  VALUES (actor, chosen::audit_action, grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason, origin);
  RETURN NEW;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  rec record;
  att record;
BEGIN
  FOR rec IN SELECT id, physical_name FROM data_tables LOOP
    BEGIN
      EXECUTE format('alter table %I add column if not exists ag_seq bigint generated by default as identity', rec.physical_name);
      EXECUTE format('alter table %I add column if not exists ag_created_at timestamptz not null default now()', rec.physical_name);
      EXECUTE format('alter table %I add column if not exists ag_updated_at timestamptz not null default now()', rec.physical_name);
      EXECUTE format('alter table %I add column if not exists ag_created_by uuid', rec.physical_name);
      EXECUTE format('alter table %I add column if not exists ag_updated_by uuid', rec.physical_name);
      EXECUTE format(
        'create unique index if not exists %I on %I (ag_seq)',
        'ix_' || substr(rec.physical_name, 3, 16) || '_37336dd1',
        rec.physical_name
      );
      EXECUTE format('drop trigger if exists ag_stamp on %I', rec.physical_name);
      EXECUTE format(
        'create trigger ag_stamp before insert or update on %I for each row execute function ag_stamp()',
        rec.physical_name
      );
      -- Attachment cells move from one key to an array of keys. ALTER ... USING
      -- rewrites the representation only and fires no row trigger.
      FOR att IN
        SELECT c.name FROM data_columns c
        JOIN information_schema.columns ic
          ON ic.table_schema = 'public' AND ic.table_name = rec.physical_name
          AND ic.column_name = c.name AND ic.data_type = 'text'
        WHERE c.table_id = rec.id AND c.field_type = 'attachment'
      LOOP
        EXECUTE format(
          'alter table %I alter column %I type text[] using case when %I is null then null else array[%I] end',
          rec.physical_name, att.name, att.name, att.name
        );
      END LOOP;
    EXCEPTION
      WHEN undefined_table THEN
        NULL;
    END;
  END LOOP;
END;
$$;--> statement-breakpoint
DELETE FROM role_bindings tb
USING data_tables t, role_bindings bb
WHERE tb.scope = 'table'
  AND tb.scope_id = t.id
  AND bb.scope = 'base'
  AND bb.scope_id = t.base_id
  AND bb.user_id = tb.user_id
  AND bb.role = tb.role;
