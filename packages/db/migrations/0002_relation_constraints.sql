ALTER TABLE "relations" ADD COLUMN "junction_name" text;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_column_id_unique" UNIQUE("from_column_id");--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_junction_name_unique" UNIQUE("junction_name");