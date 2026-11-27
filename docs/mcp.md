# Connecting an AI (MCP)

[Model Context Protocol](https://modelcontextprotocol.io) over Streamable
HTTP. AnyGridDB embeds no model and calls no outside AI (ADR 0040).

## Endpoint and token

- `https://<instance>/mcp`
- `Authorization: Bearer ag_…` (Settings → API tokens). Session cookie refused.
- Who may create tokens: Administration → Security (everyone or admins only).
  Admins-only also disables existing non-admin tokens (ADR 0044).
- Effective rights = min(token scope, owner's roles / field / row rules).
- Prefer read-only. Write tokens can omit deletes (`allowDelete` false, ADR 0079) → no `delete_records`; REST/tRPC delete → `token_cannot_delete`.
- Rate limit: 600/min per address, across every process (shared with REST).

## Tools

| Tool                | Does                                       | REST equivalent                          |
| ------------------- | ------------------------------------------ | ---------------------------------------- |
| `list_bases`        | Bases the token reaches, with the role     | `GET /api/v1/bases`                      |
| `list_tables`       | A base's tables and their fields           | `GET /api/v1/bases/:baseId/tables`       |
| `get_openapi`       | A base's OpenAPI 3.1 document              | `GET /api/v1/bases/:baseId/openapi.json` |
| `list_records`      | A page of rows: view, sort, filter, search | `GET /api/v1/tables/:tableId/records`    |
| `get_record`        | One row                                    | `GET …/records/:id`                      |
| `create_records`    | Up to 100 rows                             | `POST …/records`                         |
| `update_records`    | Up to 100 rows, each with its id           | `PATCH …/records`                        |
| `delete_records`    | Up to 100 rows by id                       | `DELETE …/records`                       |
| `transition_record` | One row's step of its table's circuit      | `POST …/records/:id/transition`          |

Read-only → read tools only. No deletes on token → no `delete_records`.
Writes use the same service as the grid (locks, signatures, trail, live
updates). Schema / views / members / settings out of reach. A step
that asks a signature is taken in the application: a token proves
nothing of its holder.

## Errors

Tool failure → HTTP 200 + JSON-RPC result with `isError: true` and `code`.
Bad args → `invalid_input` + `detail`. Tool not offered → JSON-RPC `-32602`.

## A token an application asks for

Registered OAuth app → person grants bases → token usable here:
[Applications (OAuth)](integrations/oauth.md).

## Clients

```bash
claude mcp add --transport http anygriddb https://grid.example.org/mcp \
  --header "Authorization: Bearer ag_…"
```

```json
{
  "mcpServers": {
    "anygriddb": {
      "url": "https://grid.example.org/mcp",
      "headers": { "Authorization": "Bearer ag_…" }
    }
  }
}
```

Local models (Ollama, etc.): run beside the instance; reach rows only via
`/mcp` + bearer. Stdio-only clients need an HTTP bridge (e.g. `mcp-remote`).
No `anygriddb mcp` CLI (would need DB credentials on the AI host).

| Ask                                       | Through MCP?                            |
| ----------------------------------------- | --------------------------------------- |
| Counts / lists (filters, views, search)   | Yes, under token rights                 |
| Create / update                           | Write token; prefer client confirmation |
| Delete                                    | Only if `allowDelete`                   |
| Tables / fields                           | Yes                                     |
| Schema, members, settings, Administration | No                                      |
| Who is signed in                          | No — Administration → People → Sessions |

Hard limits: never paste `aga_…` or a session cookie; no raw SQL; prefer
read-only until tool use is known; keep the model on your network for
personal data.

## The instance's certificate

Self-issued authority (ADR 0029): download
`https://<instance>/tls/authority.crt`, then
`NODE_EXTRA_CA_CERTS=/path/authority.crt` or system trust store.

## Trying the REST API

Base menu → **API and documentation**: OpenAPI + **Try it** tab (session;
writes are real and trailed).
