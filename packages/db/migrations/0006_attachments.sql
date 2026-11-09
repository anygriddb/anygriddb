CREATE TABLE "attachments" (
	"key" text PRIMARY KEY NOT NULL,
	"table_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"thumb_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_table" ON "attachments" USING btree ("table_id");--> statement-breakpoint
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT t.id AS table_id, t.physical_name, c.name AS column_name
    FROM data_columns c
    JOIN data_tables t ON t.id = c.table_id
    WHERE c.field_type = 'attachment'
  LOOP
    BEGIN
      EXECUTE format(
        'insert into attachments (key, table_id, filename, mime, size) select distinct k, %L::uuid, k, %L, 0 from %I, unnest(%I) as k where k is not null on conflict (key) do nothing',
        rec.table_id,
        'application/octet-stream',
        rec.physical_name,
        rec.column_name
      );
    EXCEPTION
      WHEN undefined_table OR undefined_column THEN
        NULL;
    END;
  END LOOP;
END;
$$;
