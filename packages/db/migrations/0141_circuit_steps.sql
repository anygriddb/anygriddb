-- Taking a circuit's steps is a permission of its own (`rows.transition`,
-- ADR 0130), which an editor's and an owner's roles give, as they took
-- steps before. A step names who takes it: one of the four, or now a role
-- an administrator made, so "may validate" is given apart from writing or
-- locking rows. `contributor`, which the shipped circuits named beside
-- editors and owners, is no role here: those grants matched nobody, and go.
ALTER TABLE "made_roles" DROP CONSTRAINT "made_roles_permissions_check";
ALTER TABLE "made_roles" ADD CONSTRAINT "made_roles_permissions_check" CHECK (
  jsonb_typeof("permissions") = 'array'
  AND "permissions" @> '["rows.read"]'::jsonb
  AND "permissions" <@ '[
    "rows.read", "rows.comment", "rows.write", "rows.delete", "rows.lock",
    "rows.transition", "data.export", "api.access", "data.import",
    "publish", "views.manage", "dashboards.manage", "schema.manage",
    "automations.manage", "webhooks.manage", "members.manage", "base.manage"
  ]'::jsonb
);

DELETE FROM "status_transition_grants" WHERE "role_key" = 'contributor';

ALTER TABLE "status_transition_grants"
  DROP CONSTRAINT "status_transition_grants_pkey",
  ALTER COLUMN "role_key" DROP NOT NULL,
  ADD COLUMN "made_role_id" uuid REFERENCES "made_roles" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "status_transition_grants_one_role"
    CHECK (("role_key" IS NULL) <> ("made_role_id" IS NULL)),
  ADD CONSTRAINT "status_transition_grants_role_key"
    CHECK ("role_key" IN ('owner', 'editor', 'commenter', 'viewer'));
CREATE UNIQUE INDEX "status_transition_grants_role"
  ON "status_transition_grants" ("transition_id", "role_key")
  WHERE "role_key" IS NOT NULL;
CREATE UNIQUE INDEX "status_transition_grants_made_role"
  ON "status_transition_grants" ("transition_id", "made_role_id")
  WHERE "made_role_id" IS NOT NULL;
CREATE INDEX "status_transition_grants_made_role_id"
  ON "status_transition_grants" ("made_role_id")
  WHERE "made_role_id" IS NOT NULL;

-- A circuit copied keeps whom each step names, made roles included.
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
    INSERT INTO status_transition_grants (transition_id, role_key, made_role_id)
    SELECT new_tr, g.role_key, g.made_role_id
      FROM status_transition_grants g
     WHERE g.transition_id = tr.id;
  END LOOP;

  RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION ag_duplicate_status_circuit(uuid, uuid) FROM PUBLIC;
