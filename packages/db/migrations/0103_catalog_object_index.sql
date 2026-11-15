-- Earlier versions of a base, a dashboard, or a widget are events whose
-- table is null: the object's id is inside the JSON. Walking a table's
-- row events to find one view would read the wrong pile. This index is
-- only the catalog events, by the object they name.
CREATE INDEX "audit_events_catalog_object_idx"
  ON "audit_events" (
    "catalog_table",
    (COALESCE("new_value"->>'id', "old_value"->>'id')),
    "occurred_at" DESC
  )
  WHERE "action" = 'catalog';
