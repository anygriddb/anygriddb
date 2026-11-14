# 0079 — API tokens that write without deleting

- Status: Accepted
- Date: 2026-11-14

## Context

An AI the operator runs talks to AnyGridDB over MCP with a bearer token
(ADR 0040). A read-only token is safe to explore with, but an agent that
must create or update rows today gets every write tool, including
`delete_records`. Small local models often obey a hostile prompt and
attempt a mass delete; the server refuses bad ids, yet a well-formed
call would erase real rows. Operators asked for a token that can write
and still cannot delete.

## Decision

- **`allow_delete` on `api_tokens`**, default `true` so existing tokens
  and scripts keep deleting when they already could.
- A write token with `allow_delete` false:
  - is not offered `delete_records` on `/mcp`;
  - is answered `token_cannot_delete` wherever it asks to delete rows:
    REST `DELETE …/records`, and the app's own API, which takes a token
    too. The refusal sits in the one function every door deletes rows
    through (`apps/api/src/services/rows.ts`).
    Create and update stay as for any write token.
- A read-only token still collapses to viewer rights (ADR 0044); it
  never deletes, whether or not `allow_delete` is set.
- The settings form defaults a new token to read-only, and when the
  person turns that off, defaults `allow_delete` off, so an AI token is
  safe unless they opt in.

## Consequences

- Operators can hand an agent a scoped write token without the delete
  tool. Revoking or switching the instance to administrator-only tokens
  still stops non-admin tokens (ADR 0044).
- OpenAPI still documents DELETE for a base: the refusal is at the
  token, not the schema of the table.
