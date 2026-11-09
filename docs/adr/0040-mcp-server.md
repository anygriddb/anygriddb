# 0040 — An MCP server over HTTP, and an API page that tries requests itself

- Status: Accepted
- Date: 2026-11-09

## Context

Clients ask to connect the AI they already run (Claude, Cursor, an
Ollama behind an MCP client) to their data, and to try the REST API from
the instance, as Swagger pages let them. AnyGridDB embeds no language
model, makes no call to an outside service, and installs without a
network (ADRs 0029, 0030).

A worktree proposed an MCP server with two transports, Streamable HTTP
and stdio, and Scalar as an in-app OpenAPI explorer.

## Decision

- **MCP over Streamable HTTP at `/mcp`, nothing else.** The tools mirror
  the REST API's record plane: `list_bases`, `list_tables`,
  `get_openapi`, `list_records`, `get_record`, `create_records`,
  `update_records`, `delete_records`. REST and MCP share
  `apps/api/src/public-api/`; writes go through the row service
  (ADR 0022), so rules, locks, audit, and realtime hold.
- **A bearer `ag_…` token only.** The session cookie is never read on
  `/mcp`, so a page cannot act through a signed-in browser; a request a
  browser sends from another origin is refused, as the protocol asks
  against DNS rebinding. The rights are the lower of the token's scope
  and its owner's roles. A read-only token is not offered the tools that
  write. Requests count in the REST API's rate bucket.
- **Stateless.** One server and one transport per request, answered as
  JSON: any API process can take any request, as for REST.
- **No stdio transport.** The proposed `anygriddb mcp` connected to
  AnyGridDB's own database with `DATABASE_URL` on the machine that runs
  the AI: a desktop holding the control plane's credentials, past every
  rule the API enforces, and unable to read a client's tables without
  the sources' keys. Clients that speak only stdio use a generic bridge
  to the HTTP endpoint.
- **No Scalar.** Its React package brings 58 MB of dependencies, a
  PostHog plugin, a chat with Scalar's servers, a request proxy on
  `proxy.scalar.com`, and fonts from `fonts.scalar.com`: outside calls the
  product refuses, and that its security policy would block. The API
  page instead has an "Essayer" tab of its own: a request on one table,
  sent with the reader's session (REST takes it on this origin), and the
  answer as it came.
- **The official MCP SDK** (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/node`, Apache-2.0).

## Consequences

- An AI reads and writes rows with a person's rights and no more; it
  cannot change schemas, views, members, or settings. Tools for those
  would be a separate decision.
- A client must trust the instance's certificate: an instance with its
  own authority hands it out at `/tls/authority.crt`, and a Node-based
  client reads it from `NODE_EXTRA_CA_CERTS`.
- The API page's tab is no full OpenAPI explorer: it covers the record
  operations, which is what the document describes.
