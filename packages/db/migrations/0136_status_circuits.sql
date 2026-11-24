-- Configurable status circuits (ADR 0124): templates, per-table copies,
-- circuit-aware audit trigger. Behaviour of the compliance circuit matches
-- the former hard-coded draft → submitted → locked → signed path.

ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'transition';--> statement-breakpoint

CREATE TABLE "status_circuits" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "table_id" uuid UNIQUE REFERENCES "data_tables" ("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "system" boolean NOT NULL DEFAULT false,
  "duplicated_from_id" uuid REFERENCES "status_circuits" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "status_circuits_template_or_table" CHECK (
    ("table_id" IS NULL AND "system" = true)
    OR ("table_id" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "status_circuits_template_key"
  ON "status_circuits" ("key") WHERE "table_id" IS NULL;--> statement-breakpoint

CREATE TABLE "status_states" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "circuit_id" uuid NOT NULL REFERENCES "status_circuits" ("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "is_initial" boolean NOT NULL DEFAULT false,
  "row_writable" boolean NOT NULL DEFAULT true,
  "writable_fields" text[],
  "allow_delete" boolean NOT NULL DEFAULT true,
  "seal" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  UNIQUE ("circuit_id", "key")
);--> statement-breakpoint

CREATE UNIQUE INDEX "status_states_one_initial"
  ON "status_states" ("circuit_id") WHERE "is_initial";--> statement-breakpoint

CREATE TABLE "status_transitions" (
  "id" uuid PRIMARY KEY DEFAULT ag_uuidv7() NOT NULL,
  "circuit_id" uuid NOT NULL REFERENCES "status_circuits" ("id") ON DELETE CASCADE,
  "from_state_id" uuid NOT NULL REFERENCES "status_states" ("id") ON DELETE CASCADE,
  "to_state_id" uuid NOT NULL REFERENCES "status_states" ("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "require_reason" boolean NOT NULL DEFAULT false,
  "require_fields" text[] NOT NULL DEFAULT '{}',
  "signature" text NOT NULL DEFAULT 'none'
    CHECK ("signature" IN ('none', 'password', 'step_up')),
  "four_eyes" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  UNIQUE ("circuit_id", "from_state_id", "key")
);--> statement-breakpoint

-- Role keys of the access ladder (and the unified authorization's packs once it lands).
CREATE TABLE "status_transition_grants" (
  "transition_id" uuid NOT NULL REFERENCES "status_transitions" ("id") ON DELETE CASCADE,
  "role_key" text NOT NULL,
  PRIMARY KEY ("transition_id", "role_key")
);--> statement-breakpoint

-- Client status leaves the fixed enum so a circuit may name its own keys.
-- What compares it with the enum goes first, and comes back on the text:
-- the same rule, and the index on what holds sealed values.
ALTER TABLE "external_statuses"
  DROP CONSTRAINT IF EXISTS "external_statuses_sealed";--> statement-breakpoint
DROP INDEX IF EXISTS "external_statuses_check";--> statement-breakpoint
ALTER TABLE "external_statuses"
  ALTER COLUMN "status" TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "external_statuses"
  ADD CONSTRAINT "external_statuses_sealed" CHECK (
    "status" = 'submitted' OR "sealed_at" IS NULL OR "fingerprint" IS NOT NULL
  );--> statement-breakpoint
CREATE INDEX "external_statuses_check" ON "external_statuses" ("checked_at" NULLS FIRST)
  WHERE "fingerprint" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "external_status_events"
  DROP CONSTRAINT IF EXISTS "external_status_events_action_check";--> statement-breakpoint
ALTER TABLE "external_status_events"
  ADD CONSTRAINT "external_status_events_action_check" CHECK (
    "action" ~ '^[a-z][a-z0-9_]{0,63}$'
  );--> statement-breakpoint
DROP TYPE IF EXISTS "public"."external_status";--> statement-breakpoint

-- Drop the fixed ag_status check on every native table.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT t.physical_name AS tbl, c.conname
      FROM data_tables t
      JOIN pg_class cls ON cls.relname = t.physical_name AND cls.relkind = 'r'
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
      JOIN pg_constraint c ON c.conrelid = cls.oid AND c.contype = 'c'
     WHERE pg_get_constraintdef(c.oid) LIKE '%ag_status%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.conname);
  END LOOP;
END $$;--> statement-breakpoint

-- Duplicate a circuit (template or table copy) onto a table.
CREATE OR REPLACE FUNCTION ag_duplicate_status_circuit(source uuid, target_table uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  src status_circuits%ROWTYPE;
  new_id uuid;
  state_map jsonb := '{}'::jsonb;
  st status_states%ROWTYPE;
  tr status_transitions%ROWTYPE;
  new_state uuid;
  new_tr uuid;
  from_new uuid;
  to_new uuid;
  rk text;
BEGIN
  SELECT * INTO src FROM status_circuits WHERE id = source;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Circuit not found';
  END IF;
  IF EXISTS (SELECT 1 FROM status_circuits WHERE table_id = target_table) THEN
    RAISE EXCEPTION 'Table already has a circuit';
  END IF;

  INSERT INTO status_circuits (table_id, key, name, system, duplicated_from_id)
  VALUES (target_table, src.key, src.name, false, src.id)
  RETURNING id INTO new_id;

  FOR st IN
    SELECT * FROM status_states WHERE circuit_id = src.id ORDER BY position, key
  LOOP
    INSERT INTO status_states (
      circuit_id, key, label, is_initial, row_writable, writable_fields,
      allow_delete, seal, position
    ) VALUES (
      new_id, st.key, st.label, st.is_initial, st.row_writable, st.writable_fields,
      st.allow_delete, st.seal, st.position
    ) RETURNING id INTO new_state;
    state_map := state_map || jsonb_build_object(st.id::text, new_state::text);
  END LOOP;

  FOR tr IN
    SELECT * FROM status_transitions WHERE circuit_id = src.id ORDER BY position, key
  LOOP
    from_new := (state_map ->> tr.from_state_id::text)::uuid;
    to_new := (state_map ->> tr.to_state_id::text)::uuid;
    INSERT INTO status_transitions (
      circuit_id, from_state_id, to_state_id, key, label,
      require_reason, require_fields, signature, four_eyes, position
    ) VALUES (
      new_id, from_new, to_new, tr.key, tr.label,
      tr.require_reason, tr.require_fields, tr.signature, tr.four_eyes, tr.position
    ) RETURNING id INTO new_tr;
    FOR rk IN
      SELECT role_key FROM status_transition_grants WHERE transition_id = tr.id
    LOOP
      INSERT INTO status_transition_grants (transition_id, role_key)
      VALUES (new_tr, rk);
    END LOOP;
  END LOOP;

  RETURN new_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_duplicate_status_circuit(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION ag_attach_compliance_circuit(target_table uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  template uuid;
BEGIN
  SELECT id INTO template FROM status_circuits
   WHERE table_id IS NULL AND key = 'compliance';
  IF template IS NULL THEN
    RAISE EXCEPTION 'Compliance template missing';
  END IF;
  RETURN ag_duplicate_status_circuit(template, target_table);
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_attach_compliance_circuit(uuid) FROM PUBLIC;--> statement-breakpoint

-- Seed shipped templates (immutable; table_id null).
INSERT INTO "status_circuits" ("id", "table_id", "key", "name", "system") VALUES
  ('c0000000-0000-7000-8000-000000000001', NULL, 'compliance', 'Compliance', true),
  ('c0000000-0000-7000-8000-000000000002', NULL, 'simple_review', 'Simple review', true),
  ('c0000000-0000-7000-8000-000000000003', NULL, 'dual_approval', 'Dual approval', true);--> statement-breakpoint

-- compliance states
INSERT INTO "status_states" ("id", "circuit_id", "key", "label", "is_initial", "row_writable", "allow_delete", "seal", "position") VALUES
  ('c0000000-0000-7000-8000-000000000011', 'c0000000-0000-7000-8000-000000000001', 'draft', 'Draft', true, true, true, false, 0),
  ('c0000000-0000-7000-8000-000000000012', 'c0000000-0000-7000-8000-000000000001', 'submitted', 'Submitted', false, true, true, false, 1),
  ('c0000000-0000-7000-8000-000000000013', 'c0000000-0000-7000-8000-000000000001', 'locked', 'Locked', false, false, false, true, 2),
  ('c0000000-0000-7000-8000-000000000014', 'c0000000-0000-7000-8000-000000000001', 'signed', 'Signed', false, false, false, true, 3);--> statement-breakpoint

INSERT INTO "status_transitions" ("id", "circuit_id", "from_state_id", "to_state_id", "key", "label", "signature", "position") VALUES
  ('c0000000-0000-7000-8000-000000000021', 'c0000000-0000-7000-8000-000000000001', 'c0000000-0000-7000-8000-000000000011', 'c0000000-0000-7000-8000-000000000012', 'submit', 'Submit', 'none', 0),
  ('c0000000-0000-7000-8000-000000000022', 'c0000000-0000-7000-8000-000000000001', 'c0000000-0000-7000-8000-000000000012', 'c0000000-0000-7000-8000-000000000013', 'lock', 'Lock', 'none', 1),
  ('c0000000-0000-7000-8000-000000000023', 'c0000000-0000-7000-8000-000000000001', 'c0000000-0000-7000-8000-000000000013', 'c0000000-0000-7000-8000-000000000014', 'sign', 'Sign', 'password', 2),
  ('c0000000-0000-7000-8000-000000000024', 'c0000000-0000-7000-8000-000000000001', 'c0000000-0000-7000-8000-000000000013', 'c0000000-0000-7000-8000-000000000011', 'unlock', 'Unlock', 'none', 3),
  ('c0000000-0000-7000-8000-000000000025', 'c0000000-0000-7000-8000-000000000001', 'c0000000-0000-7000-8000-000000000014', 'c0000000-0000-7000-8000-000000000011', 'unlock', 'Unlock', 'none', 4);--> statement-breakpoint

INSERT INTO "status_transition_grants" ("transition_id", "role_key") VALUES
  ('c0000000-0000-7000-8000-000000000021', 'editor'),
  ('c0000000-0000-7000-8000-000000000021', 'owner'),
  ('c0000000-0000-7000-8000-000000000021', 'contributor'),
  ('c0000000-0000-7000-8000-000000000022', 'owner'),
  ('c0000000-0000-7000-8000-000000000023', 'owner'),
  ('c0000000-0000-7000-8000-000000000024', 'owner'),
  ('c0000000-0000-7000-8000-000000000025', 'owner');--> statement-breakpoint

-- simple_review
INSERT INTO "status_states" ("id", "circuit_id", "key", "label", "is_initial", "row_writable", "allow_delete", "seal", "position") VALUES
  ('c0000000-0000-7000-8000-000000000031', 'c0000000-0000-7000-8000-000000000002', 'draft', 'Draft', true, true, true, false, 0),
  ('c0000000-0000-7000-8000-000000000032', 'c0000000-0000-7000-8000-000000000002', 'in_review', 'In review', false, false, false, false, 1),
  ('c0000000-0000-7000-8000-000000000033', 'c0000000-0000-7000-8000-000000000002', 'approved', 'Approved', false, false, false, true, 2);--> statement-breakpoint

INSERT INTO "status_transitions" ("id", "circuit_id", "from_state_id", "to_state_id", "key", "label", "position") VALUES
  ('c0000000-0000-7000-8000-000000000041', 'c0000000-0000-7000-8000-000000000002', 'c0000000-0000-7000-8000-000000000031', 'c0000000-0000-7000-8000-000000000032', 'submit', 'Submit for review', 0),
  ('c0000000-0000-7000-8000-000000000042', 'c0000000-0000-7000-8000-000000000002', 'c0000000-0000-7000-8000-000000000032', 'c0000000-0000-7000-8000-000000000033', 'approve', 'Approve', 1),
  ('c0000000-0000-7000-8000-000000000043', 'c0000000-0000-7000-8000-000000000002', 'c0000000-0000-7000-8000-000000000032', 'c0000000-0000-7000-8000-000000000031', 'reject', 'Reject', 2);--> statement-breakpoint

INSERT INTO "status_transition_grants" ("transition_id", "role_key") VALUES
  ('c0000000-0000-7000-8000-000000000041', 'editor'),
  ('c0000000-0000-7000-8000-000000000041', 'owner'),
  ('c0000000-0000-7000-8000-000000000041', 'contributor'),
  ('c0000000-0000-7000-8000-000000000042', 'owner'),
  ('c0000000-0000-7000-8000-000000000043', 'owner');--> statement-breakpoint

-- dual_approval
INSERT INTO "status_states" ("id", "circuit_id", "key", "label", "is_initial", "row_writable", "allow_delete", "seal", "position") VALUES
  ('c0000000-0000-7000-8000-000000000051', 'c0000000-0000-7000-8000-000000000003', 'draft', 'Draft', true, true, true, false, 0),
  ('c0000000-0000-7000-8000-000000000052', 'c0000000-0000-7000-8000-000000000003', 'submitted', 'Submitted', false, true, true, false, 1),
  ('c0000000-0000-7000-8000-000000000053', 'c0000000-0000-7000-8000-000000000003', 'approved_once', 'Approved once', false, false, false, false, 2),
  ('c0000000-0000-7000-8000-000000000054', 'c0000000-0000-7000-8000-000000000003', 'approved', 'Approved', false, false, false, true, 3);--> statement-breakpoint

INSERT INTO "status_transitions" ("id", "circuit_id", "from_state_id", "to_state_id", "key", "label", "four_eyes", "position") VALUES
  ('c0000000-0000-7000-8000-000000000061', 'c0000000-0000-7000-8000-000000000003', 'c0000000-0000-7000-8000-000000000051', 'c0000000-0000-7000-8000-000000000052', 'submit', 'Submit', false, 0),
  ('c0000000-0000-7000-8000-000000000062', 'c0000000-0000-7000-8000-000000000003', 'c0000000-0000-7000-8000-000000000052', 'c0000000-0000-7000-8000-000000000053', 'approve_first', 'First approval', false, 1),
  ('c0000000-0000-7000-8000-000000000063', 'c0000000-0000-7000-8000-000000000003', 'c0000000-0000-7000-8000-000000000053', 'c0000000-0000-7000-8000-000000000054', 'approve_second', 'Second approval', true, 2),
  ('c0000000-0000-7000-8000-000000000064', 'c0000000-0000-7000-8000-000000000003', 'c0000000-0000-7000-8000-000000000052', 'c0000000-0000-7000-8000-000000000051', 'reject', 'Reject', false, 3),
  ('c0000000-0000-7000-8000-000000000065', 'c0000000-0000-7000-8000-000000000003', 'c0000000-0000-7000-8000-000000000053', 'c0000000-0000-7000-8000-000000000051', 'reject', 'Reject', false, 4);--> statement-breakpoint

INSERT INTO "status_transition_grants" ("transition_id", "role_key") VALUES
  ('c0000000-0000-7000-8000-000000000061', 'editor'),
  ('c0000000-0000-7000-8000-000000000061', 'owner'),
  ('c0000000-0000-7000-8000-000000000061', 'contributor'),
  ('c0000000-0000-7000-8000-000000000062', 'owner'),
  ('c0000000-0000-7000-8000-000000000063', 'owner'),
  ('c0000000-0000-7000-8000-000000000064', 'owner'),
  ('c0000000-0000-7000-8000-000000000065', 'owner');--> statement-breakpoint

-- Every existing table gets its own compliance copy.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN SELECT id FROM data_tables LOOP
    PERFORM ag_attach_compliance_circuit(rec.id);
  END LOOP;
END $$;--> statement-breakpoint
-- Circuit-aware audit trigger (same outcomes for compliance as before).
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
  circuit uuid;
  initial_key text;
  old_writable boolean;
  old_delete boolean;
  new_writable boolean;
  from_seal boolean;
  to_writable boolean;
  tr_key text;
  tr_to text;
  changed_cols text[];
  allowed text[];
  col text;
  audit_act text;
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

  -- A table with no circuit of its own follows the shipped compliance one,
  -- as every table did before circuits.
  SELECT c.id INTO circuit FROM status_circuits c WHERE c.table_id = grid_id;
  IF circuit IS NULL THEN
    SELECT c.id INTO circuit FROM status_circuits c
     WHERE c.table_id IS NULL AND c.key = 'compliance';
  END IF;
  IF circuit IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;

  SELECT s.key INTO initial_key
    FROM status_states s
   WHERE s.circuit_id = circuit AND s.is_initial
   LIMIT 1;
  IF initial_key IS NULL THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.ag_status IS DISTINCT FROM initial_key THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'insert', grid_id, NEW.id, NULL, to_jsonb(NEW), reason, origin);
    RETURN NEW;
  END IF;

  -- A circuit replaced by its owner's function moves the rows of a state
  -- it no longer has (ag_replace_status_circuit, which has refused to move
  -- a sealed one). Only whoever owns the table may: the application's own
  -- role does not, so setting the action alone does nothing.
  IF TG_OP = 'UPDATE'
     AND current_setting('anygrid.action', true) = 'remap'
     AND pg_has_role(
       current_user,
       (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID),
       'MEMBER'
     ) THEN
    IF (to_jsonb(NEW) - 'ag_status') IS DISTINCT FROM (to_jsonb(OLD) - 'ag_status')
       OR NOT EXISTS (
         SELECT 1 FROM status_states s
          WHERE s.circuit_id = circuit AND s.key = NEW.ag_status
       ) THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'transition', grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason, origin);
    RETURN NEW;
  END IF;

  SELECT s.row_writable, s.allow_delete, s.seal
    INTO old_writable, old_delete, from_seal
    FROM status_states s
   WHERE s.circuit_id = circuit AND s.key = OLD.ag_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT old_delete THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
    VALUES (actor, 'delete', grid_id, OLD.id, to_jsonb(OLD), NULL, reason, origin);
    RETURN OLD;
  END IF;

  status_only := (to_jsonb(NEW) - 'ag_status') = (to_jsonb(OLD) - 'ag_status');
  requested := current_setting('anygrid.action', true);

  IF NEW.ag_status IS DISTINCT FROM OLD.ag_status THEN
    IF NOT status_only THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    SELECT tr.key, to_s.key, to_s.row_writable
      INTO tr_key, tr_to, to_writable
      FROM status_transitions tr
      JOIN status_states from_s ON from_s.id = tr.from_state_id
      JOIN status_states to_s ON to_s.id = tr.to_state_id
     WHERE tr.circuit_id = circuit
       AND from_s.key = OLD.ag_status
       AND to_s.key = NEW.ag_status
       AND tr.key = requested
     LIMIT 1;
    IF tr_key IS NULL THEN
      -- Unlock-style: destination writable, source not, flag set, matching unlock transition.
      IF current_setting('anygrid.unlock', true) = 'on' THEN
        SELECT tr.key, to_s.key, to_s.row_writable
          INTO tr_key, tr_to, to_writable
          FROM status_transitions tr
          JOIN status_states from_s ON from_s.id = tr.from_state_id
          JOIN status_states to_s ON to_s.id = tr.to_state_id
         WHERE tr.circuit_id = circuit
           AND from_s.key = OLD.ag_status
           AND to_s.key = NEW.ag_status
           AND to_s.row_writable
           AND NOT from_s.row_writable
         LIMIT 1;
      END IF;
    END IF;
    IF tr_key IS NULL OR tr_to IS DISTINCT FROM NEW.ag_status THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
    IF tr_key IN ('submit', 'lock', 'unlock', 'sign') THEN
      audit_act := tr_key;
    ELSE
      audit_act := 'transition';
    END IF;
    chosen := audit_act;
  ELSE
    IF NOT old_writable THEN
      RAISE EXCEPTION 'Row locked';
    END IF;
    SELECT s.writable_fields INTO allowed
      FROM status_states s
     WHERE s.circuit_id = circuit AND s.key = OLD.ag_status;
    IF allowed IS NOT NULL THEN
      SELECT array_agg(k) INTO changed_cols
        FROM (
          SELECT key AS k FROM jsonb_each(to_jsonb(NEW) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by' - 'ag_position')
          EXCEPT
          SELECT key FROM jsonb_each(to_jsonb(OLD) - 'ag_status' - 'ag_updated_at' - 'ag_updated_by' - 'ag_position')
        ) d
        WHERE (to_jsonb(NEW) -> d.k) IS DISTINCT FROM (to_jsonb(OLD) -> d.k);
      IF changed_cols IS NOT NULL THEN
        FOREACH col IN ARRAY changed_cols LOOP
          IF NOT (col = ANY (allowed)) THEN
            RAISE EXCEPTION 'Row locked';
          END IF;
        END LOOP;
      END IF;
    END IF;
    chosen := 'update';
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, record_id, old_value, new_value, reason, source)
  VALUES (actor, chosen::audit_action, grid_id, NEW.id, to_jsonb(OLD), to_jsonb(NEW), reason, origin);
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- New tables: no fixed status check; default remains draft (compliance initial).
CREATE OR REPLACE FUNCTION ag_create_table(tbl text, columns text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  fields jsonb := columns::jsonb;
  field jsonb;
  defs text := '';
BEGIN
  PERFORM ag_assert_table_name(tbl);
  IF jsonb_typeof(fields) <> 'array' OR jsonb_array_length(fields) > 200 THEN
    RAISE EXCEPTION 'Invalid column count';
  END IF;
  FOR field IN SELECT value FROM jsonb_array_elements(fields) LOOP
    PERFORM ag_assert_field_column(field->>'name');
    defs := defs || format(', %I %s', field->>'name', ag_field_sql_type(field->>'fieldType'));
  END LOOP;
  EXECUTE format(
    'CREATE TABLE %I ("id" uuid PRIMARY KEY DEFAULT ag_uuidv7(), '
    || '"ag_status" text NOT NULL DEFAULT ''draft'', '
    || '"ag_seq" bigint GENERATED BY DEFAULT AS IDENTITY, '
    || '"ag_position" numeric NOT NULL DEFAULT nextval(''ag_row_position''), '
    || '"ag_created_at" timestamptz NOT NULL DEFAULT now(), '
    || '"ag_updated_at" timestamptz NOT NULL DEFAULT now(), '
    || '"ag_created_by" uuid, "ag_updated_by" uuid%s)',
    tbl, defs
  );
  EXECUTE format('CREATE UNIQUE INDEX %I ON %I ("ag_seq")', ag_index_name(tbl, 'ag_seq', 'ix'), tbl);
  EXECUTE format('CREATE INDEX %I ON %I ("ag_position", "ag_seq")', ag_index_name(tbl, 'ag_position', 'ix'), tbl);
  FOR field IN SELECT value FROM jsonb_array_elements(fields) WHERE value->>'fieldType' = 'attachment' LOOP
    EXECUTE format('CREATE INDEX %I ON %I USING gin (%I)', ag_index_name(tbl, field->>'name', 'gin'), tbl, field->>'name');
  END LOOP;
  EXECUTE format('CREATE TRIGGER ag_stamp BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ag_stamp()', tbl);
  EXECUTE format('CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_record()', tbl);
END;
$$;--> statement-breakpoint

-- Sealed rows: states with seal on the table's circuit.
CREATE OR REPLACE FUNCTION ag_signed_rows_holding(tbl text, col text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  held bigint;
  circuit uuid;
BEGIN
  PERFORM ag_assert_table_name(tbl);
  SELECT c.id INTO circuit
    FROM status_circuits c
    JOIN data_tables t ON t.id = c.table_id
   WHERE t.physical_name = tbl;
  IF circuit IS NULL THEN
    SELECT c.id INTO circuit FROM status_circuits c
     WHERE c.table_id IS NULL AND c.key = 'compliance';
  END IF;
  IF col IS NULL THEN
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "ag_status" IN (SELECT key FROM status_states WHERE circuit_id = $1 AND seal)',
      tbl
    ) INTO held USING circuit;
  ELSE
    PERFORM ag_assert_field_column(col);
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "ag_status" IN (SELECT key FROM status_states WHERE circuit_id = $1 AND seal) AND %I IS NOT NULL',
      tbl, col
    ) INTO held USING circuit;
  END IF;
  RETURN coalesce(held, 0);
END;
$$;--> statement-breakpoint

-- Every new table gets a compliance circuit unless one was already attached.
CREATE OR REPLACE FUNCTION ag_data_table_circuit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM status_circuits WHERE table_id = NEW.id) THEN
    PERFORM ag_attach_compliance_circuit(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_data_table_circuit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER ag_data_table_circuit
  AFTER INSERT ON data_tables
  FOR EACH ROW EXECUTE FUNCTION ag_data_table_circuit();--> statement-breakpoint

-- The application reads circuits and never writes them (ADR 0119): the
-- trigger takes its rules from there, so a role that could rewrite them
-- could unseal a signed row. A table's circuit changes only here, and the
-- change is on the trail.
CREATE FUNCTION ag_replace_status_circuit(target_table uuid, template_key text, remap jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  said text := current_setting('anygrid.user_id', true);
  actor uuid;
  grid data_tables%ROWTYPE;
  template uuid;
  former status_circuits%ROWTYPE;
  moves jsonb := coalesce(remap, '{}'::jsonb);
  pair record;
  sealed record;
  held bigint;
  new_id uuid;
BEGIN
  IF said ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO actor FROM users WHERE id = said::uuid;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Audit context required';
  END IF;
  SELECT * INTO grid FROM data_tables WHERE id = target_table FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table not found';
  END IF;
  SELECT id INTO template FROM status_circuits
   WHERE table_id IS NULL AND key = template_key;
  IF template IS NULL THEN
    RAISE EXCEPTION 'Circuit not found';
  END IF;
  IF jsonb_typeof(moves) <> 'object' THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each_text(moves) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM status_states WHERE circuit_id = template AND key = pair.value
    ) THEN
      RAISE EXCEPTION 'Invalid status';
    END IF;
  END LOOP;

  SELECT * INTO former FROM status_circuits WHERE table_id = target_table FOR UPDATE;
  IF FOUND THEN
    -- A sealed row stays sealed: never moved, and its state stays a sealed
    -- one that neither writes nor deletes.
    FOR sealed IN
      SELECT key FROM status_states WHERE circuit_id = former.id AND seal
    LOOP
      IF moves ? sealed.key THEN
        RAISE EXCEPTION 'Row locked';
      END IF;
      IF grid.storage = 'external' THEN
        SELECT count(*) INTO held FROM external_statuses
         WHERE table_id = target_table AND status = sealed.key;
      ELSE
        EXECUTE format('SELECT count(*) FROM %I WHERE "ag_status" = $1', grid.physical_name)
          INTO held USING sealed.key;
      END IF;
      IF held > 0 AND NOT EXISTS (
        SELECT 1 FROM status_states
         WHERE circuit_id = template AND key = sealed.key
           AND seal AND NOT row_writable AND NOT allow_delete
      ) THEN
        RAISE EXCEPTION 'Row locked';
      END IF;
    END LOOP;
    DELETE FROM status_circuits WHERE id = former.id;
  END IF;
  new_id := ag_duplicate_status_circuit(template, target_table);

  PERFORM set_config('anygrid.action', 'remap', true);
  FOR pair IN SELECT key, value FROM jsonb_each_text(moves) LOOP
    IF grid.storage = 'external' THEN
      UPDATE external_statuses SET status = pair.value
       WHERE table_id = target_table AND status = pair.key;
    ELSE
      EXECUTE format('UPDATE %I SET "ag_status" = $1 WHERE "ag_status" = $2', grid.physical_name)
        USING pair.value, pair.key;
    END IF;
  END LOOP;
  PERFORM set_config('anygrid.action', '', true);

  -- No row is left in a state the circuit does not have.
  IF grid.storage = 'external' THEN
    SELECT count(*) INTO held FROM external_statuses
     WHERE table_id = target_table
       AND status NOT IN (SELECT key FROM status_states WHERE circuit_id = new_id);
  ELSE
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "ag_status" NOT IN (SELECT key FROM status_states WHERE circuit_id = $1)',
      grid.physical_name
    ) INTO held USING new_id;
  END IF;
  IF held > 0 THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  INSERT INTO audit_events (user_id, action, table_id, catalog_table, old_value, new_value, source)
  VALUES (
    actor,
    'catalog',
    target_table,
    'status_circuits',
    CASE WHEN former.id IS NULL THEN NULL ELSE jsonb_build_object('circuit', former.key) END,
    jsonb_build_object('circuit', template_key, 'remap', moves),
    'structure'
  );
  RETURN new_id;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ag_replace_status_circuit(uuid, text, jsonb) FROM PUBLIC;--> statement-breakpoint
