-- ADR 0142: the attributes an instance knows of a person (a ward, a
-- branch, a department), and each account's values, which a rule may name
-- as "the reader's". Both are on the change trail: a value changes what
-- its holder reaches.
CREATE TABLE "person_attributes" (
  "key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  -- The field of SCIM's enterprise extension that provides it, if any.
  "scim_field" text,
  "created_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "person_attributes_key"
    CHECK ("key" ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT "person_attributes_label"
    CHECK (length(btrim("label")) BETWEEN 1 AND 60),
  CONSTRAINT "person_attributes_scim"
    CHECK ("scim_field" IN ('department', 'division', 'organization', 'costCenter'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "person_attributes_label_once"
  ON "person_attributes" (lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "person_attributes_scim_once"
  ON "person_attributes" ("scim_field") WHERE "scim_field" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "person_attributes_created_by" ON "person_attributes" ("created_by")
  WHERE "created_by" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "account_attributes" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "key" text NOT NULL REFERENCES "person_attributes" ("key") ON DELETE CASCADE,
  -- A person may hold several: two wards, two branches.
  "values" text[] NOT NULL,
  "updated_by" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "key"),
  CONSTRAINT "account_attributes_values"
    CHECK (cardinality("values") BETWEEN 1 AND 20
      AND array_position("values", NULL) IS NULL
      AND length(array_to_string("values", '')) <= 4000)
);--> statement-breakpoint
CREATE INDEX "account_attributes_key" ON "account_attributes" ("key");--> statement-breakpoint
CREATE INDEX "account_attributes_updated_by" ON "account_attributes" ("updated_by")
  WHERE "updated_by" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON "person_attributes"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();--> statement-breakpoint
CREATE TRIGGER audit_catalog
  AFTER INSERT OR UPDATE OR DELETE ON "account_attributes"
  FOR EACH ROW
  EXECUTE FUNCTION audit_catalog();
