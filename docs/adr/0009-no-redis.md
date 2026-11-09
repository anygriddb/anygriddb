# 0009 — No Redis

- Status: Accepted
- Date: 2026-11-07

## Context

Redis 7.2 is a required service today. It is pinned because 7.4 moved to
RSALv2 and SSPL. That rule is out of date: Redis 8 has been available under
AGPLv3, an OSI license, since May 2025, and Valkey (BSD) exists. Pinning an
old line forever is a security debt.

Once events and jobs live in PostgreSQL (ADR 0008), Redis only holds
short-lived state: pub/sub, presence, rate limits, cell locks, and staged
import files.

## Decision

Redis leaves the stack.

| Use today                           | Replacement                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Event list, job wake-up             | graphile-worker (ADR 0008)                                                     |
| Realtime fan-out across instances   | `LISTEN/NOTIFY`, sent after commit and in batches; messages carry row ids only |
| Presence                            | In memory per instance, shared through `NOTIFY`                                |
| Rate limits                         | In memory per instance                                                         |
| Cell locks                          | A table with an expiry                                                         |
| Staged imports and snapshot uploads | The file in storage (ADR 0010), its state in a table                           |
| Job files without object storage    | Local storage (ADR 0010)                                                       |

The required stack becomes PostgreSQL and AnyGridDB.

## Consequences

- `NOTIFY` takes a global lock at commit. Notifying after commit, in
  batches, keeps that cost away from write transactions.
- With several instances, per-instance rate limits multiply by the number
  of instances. That is acceptable for the target scale.
- If an instance ever outgrows `LISTEN/NOTIFY`, an optional Valkey adapter
  for fan-out alone can be added. Nothing durable would depend on it.

## Rejected

- **Valkey as a required service.** One more component for state that
  PostgreSQL handles.
