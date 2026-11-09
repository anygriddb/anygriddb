# 0022 — One application service layer under every transport

- Status: Accepted
- Date: 2026-11-07

## Context

Business logic lives in the transports. `apps/api/src/trpc/rows-router.ts`
(981 lines) and `apps/api/src/rest-api.ts` (1,033 lines) each query the
catalog with Drizzle and each announce row changes.

They have already drifted. `announceRows` (`apps/api/src/data/announce.ts`)
publishes the changed rows, marks dependent tables stale, and queues row
events. The REST API's own `announce` publishes rows and queues events, but
never calls `publishStale`. A write through the public API leaves the
lookups and rollups of other tables stale in every open tab.

ADR 0016 fixed the same kind of defect for field and row rules by moving
enforcement into the read engine. Writes and events need the same single
path.

## Decision

- **Application services** hold every command and query: write rows, link
  rows, change a status, sign, comment, restore, and so on. A service:
  - takes an actor and validated input;
  - builds its engine with `readerEngine()` (ADR 0016);
  - checks `assertFieldsWritable` and `assertRowsInScope`;
  - writes;
  - emits events from one place.
- **Transports stay thin**: tRPC, the public REST API, automations, jobs,
  and any later transport (an MCP server, for example). They authenticate,
  validate the input shape, call a service, and serialize the result. They
  contain no SQL and no event fan-out.
- **Events are emitted in the service only.** Phase 1 of the migration plan
  makes that emission a graphile-worker enqueue inside the write's
  transaction (ADR 0008).
- **tRPC stays** for the web app. Once it is thin, it remains the best
  internal contract for a TypeScript client. The public REST API stays a
  separate, versioned contract.

## Consequences

- A new transport gets every rule, every audit entry, and every event by
  calling the service.
- Each service gets an integration test once, instead of each transport
  being tested for each rule.
- Phase 1 starts by extracting the row write service. An integration test
  shows that a REST write marks dependent tables stale.

## Rejected

- **Replacing tRPC with one OpenAPI contract** (Fastify routes with a Zod
  type provider, a generated client), or with oRPC. Defensible, but the
  defect comes from logic in the transports, not from tRPC. A
  language-neutral contract would matter only if the server language
  changed, and ADR 0021 keeps it.
- **Fixing the missing `publishStale` call alone.** The next surface would
  drift again.
