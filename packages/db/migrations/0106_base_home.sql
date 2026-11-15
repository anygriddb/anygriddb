-- A base may keep the tables it creates in a schema of a SQL source.
-- Both columns are set together. A table that already existed at the
-- client is never one of these: that one stays a source the base reads.
ALTER TABLE "bases" ADD COLUMN "home_source_id" uuid;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "home_schema" text;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_home_source_id_sources_id_fk" FOREIGN KEY ("home_source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_home_pair" CHECK (("home_source_id" IS NULL) = ("home_schema" IS NULL));
