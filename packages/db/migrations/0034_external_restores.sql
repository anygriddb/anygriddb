-- A row deleted through AnyGridDB and put back from the trash (ADR 0007):
-- the insert names the delete it restores, so the row leaves the trash
-- even when the client's database gives it a new key.
ALTER TABLE "external_writes" ADD COLUMN "restores" uuid REFERENCES "external_writes"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "external_writes_restores" ON "external_writes" ("restores") WHERE "restores" IS NOT NULL;
