# 0098 — An application finds the grant's addresses, and proves itself by header or body

- Status: Accepted
- Date: 2026-11-16
- Amends: 0094

## Context

ADR 0094 gave applications the authorization code grant, with the
client's secret read from the request's body only and no document
saying where the addresses are. RFC 6749 asks a server that issues
client secrets to take them in the `Authorization: Basic` header, which
is where most client libraries put them; and a client that discovers a
server reads its metadata (RFC 8414) before anything else. An
application written against the standard could therefore not connect
without code of its own.

## Decision

- **`/.well-known/oauth-authorization-server`** answers the addresses of
  the grant on `PUBLIC_URL`, the grants, the PKCE method, and the ways a
  client proves itself.
- **A client proves itself by header or by body**: `Authorization:
Basic`, its two parts form-encoded, or `client_id` and `client_secret`
  in the form. A secret sent both ways is refused (`invalid_request`).
- **A client that does not prove itself is answered 401
  `invalid_client`**, with the scheme it may use, and no longer the
  `invalid_grant` a wrong code gets.
- Applications still do not register themselves: an administrator names
  what is trusted (ADR 0094).

## Consequences

- A standard OAuth library connects with the metadata's address, a
  client id and a secret.
- An MCP client that expects to register itself still needs its client
  id and secret typed in.

## Rejected

- **Dynamic client registration now.** Any origin could then ask people
  for access under a name of its choosing; the administrator's list is
  the product's answer until a need shows otherwise.
