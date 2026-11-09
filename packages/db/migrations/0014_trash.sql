ALTER TYPE "public"."job_kind" ADD VALUE 'trash_purge';--> statement-breakpoint
DROP INDEX "data_tables_base_name";--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bases" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "data_columns" ADD COLUMN "deleted_with" uuid;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_columns" ADD CONSTRAINT "data_columns_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_tables_base_name" ON "data_tables" USING btree ("base_id","name") WHERE "data_tables"."deleted_at" is null;