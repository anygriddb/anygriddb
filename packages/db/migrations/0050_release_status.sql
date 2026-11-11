-- Last GitHub release check for Administration (ADR 0048): one row, filled
-- only while releaseCheck is on. Not an instance setting the admin edits.
CREATE TABLE "release_status" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
  "current" text NOT NULL,
  "latest" text NOT NULL,
  "newer" boolean NOT NULL,
  "url" text NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  "dismissed_version" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "release_status_current_semver"
    CHECK ("current" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT "release_status_latest_semver"
    CHECK ("latest" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT "release_status_dismissed_semver"
    CHECK (
      "dismissed_version" IS NULL
      OR "dismissed_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    ),
  CONSTRAINT "release_status_url_http"
    CHECK ("url" ~ '^https://')
);
