# 0094 — OAuth for applications

- Status: Accepted
- Date: 2026-11-16
- Relates to: 0040 (MCP bearer tokens), 0043/0044 (token policy),
  0079 (allow-delete), 0086 (administration API tokens)

## Context

REST and MCP take a bearer `ag_…` token only (ADR 0040). A person can
mint one in Settings. An application that signs a person in cannot: it
has no way to ask for access to chosen bases and take it back without
asking the person to paste a token. Connectors outside this tree
(ROADMAP #106) need the same door.

## Decision

- **The instance is an OAuth 2.1 authorization server** for its own API
  and MCP endpoint. Grant type: authorization code with PKCE (S256).
  Refresh tokens rotate. No implicit, no device flow, no JWT access
  tokens in this cut.
- **Clients are registered by an administrator**, with a name and one or
  more redirect URIs. The client secret is shown once. Dynamic client
  registration and `/.well-known` metadata come later.
- **Consent is the person's.** They pick at least one base they may
  reach, and whether the grant is read-only or may delete (same defaults
  as Settings tokens). The grant creates a normal `api_tokens` row so
  REST, MCP, rate limits, policy ceilings, emergency revoke, and account
  erasure stay one path. The token's name names the client.
- **Endpoints:** `/oauth/authorize` (session required), `/oauth/token`,
  `/oauth/revoke`. Errors follow RFC 6749; no secret in a log or the
  change trail.
- **SSO's `oauth_states` stay for inbound sign-in only.** Application
  grants use their own tables.

## Consequences

- An MCP client that can open a browser completes the flow; one that
  only speaks stdio still needs a pasted token or a bridge until DCR.
- Administration API tokens (`aga_…`, ADR 0086) stay apart: an OAuth
  grant never reaches Administration.
- Token policy (`apiTokens`, `tokenMaxDays`) applies to OAuth-minted
  tokens as to any other.

## Rejected

- Replacing bearer tokens with JWT: every client and MCP bridge would
  change for no gain on a single-instance product.
- Letting any origin register itself (DCR) before an administrator can
  name what is trusted.
