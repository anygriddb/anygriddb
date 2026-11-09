CREATE TYPE "public"."column_access" AS ENUM('hide', 'read', 'write');--> statement-breakpoint
CREATE TABLE "table_acls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"row_filter" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "column_acls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"column_name" text NOT NULL,
	"access" "column_access" NOT NULL
);--> statement-breakpoint
ALTER TABLE "table_acls" ADD CONSTRAINT "table_acls_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_acls" ADD CONSTRAINT "table_acls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_acls" ADD CONSTRAINT "column_acls_table_id_data_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_acls" ADD CONSTRAINT "column_acls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "table_acls_table_user" ON "table_acls" USING btree ("table_id","user_id");--> statement-breakpoint
CREATE INDEX "table_acls_table" ON "table_acls" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "column_acls_table_user_column" ON "column_acls" USING btree ("table_id","user_id","column_name");--> statement-breakpoint
CREATE INDEX "column_acls_table_user" ON "column_acls" USING btree ("table_id","user_id");
