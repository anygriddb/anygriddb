-- Origins allowed to embed a public share in an iframe (ADR 0067).
-- Null or empty: the share keeps frame-ancestors 'none' like the rest of the app.
ALTER TABLE "shares"
  ADD COLUMN "embed_origins" jsonb;--> statement-breakpoint
ALTER TABLE "shares"
  ADD CONSTRAINT "shares_embed_origins_array"
    CHECK (
      "embed_origins" IS NULL
      OR (
        jsonb_typeof("embed_origins") = 'array'
        AND jsonb_array_length("embed_origins") <= 20
      )
    );
