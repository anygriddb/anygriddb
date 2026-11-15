-- Two field types (ROADMAP #95): a colour, kept as `#rrggbb`, and a place,
-- kept as `latitude,longitude` in decimal degrees, which a map reads.
-- Both are text in the row's table: no column changes here.
ALTER TYPE "public"."field_type" ADD VALUE IF NOT EXISTS 'color';--> statement-breakpoint
ALTER TYPE "public"."field_type" ADD VALUE IF NOT EXISTS 'place';
