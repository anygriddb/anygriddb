# Connecting an AI (MCP)

AnyGridDB serves the [Model Context Protocol](https://modelcontextprotocol.io)
so that an AI you run reads and writes your rows: Claude, Cursor, or a local
model behind an MCP client. AnyGridDB embeds no model and calls no outside
service (ADR 0040).

## Endpoint and token

- Address: `https://<instance>/mcp` (Streamable HTTP).
- Authentication: `Authorization: Bearer ag_…`, a token created in
  **Settings → API tokens**. A session cookie is not accepted.
- **Who may create a token.** The instance policy (Administration →
  Security) is either everyone or administrators only. When it is
  administrators only, a non-administrator cannot create a token, and
  any token they already hold **stops working** until the policy is
  opened again (ADR 0044). An administrator creates a token under their
  own account, or opens the policy for the person who will run the AI.
- Rights: the lower of the token's scope (its bases, read-only or not,
  and whether it may delete) and its owner's roles, field and row rules
  included.
- **Prefer a read-only token to explore.** A write token can omit
  deletes (`allowDelete` false, ADR 0079): create and update stay;
  `delete_records` is not offered on MCP, and a delete asked any other
  way (REST `DELETE`, the app's own API) is answered
  `token_cannot_delete`. Leave deletes off for an AI unless you need
  them.
- Requests count in the REST API's limit: 600 a minute per address and
  process.

## Tools

| Tool             | Does                                       | REST equivalent                          |
| ---------------- | ------------------------------------------ | ---------------------------------------- |
| `list_bases`     | Bases the token reaches, with the role     | `GET /api/v1/bases`                      |
| `list_tables`    | A base's tables and their fields           | `GET /api/v1/bases/:baseId/tables`       |
| `get_openapi`    | A base's OpenAPI 3.1 document              | `GET /api/v1/bases/:baseId/openapi.json` |
| `list_records`   | A page of rows: view, sort, filter, search | `GET /api/v1/tables/:tableId/records`    |
| `get_record`     | One row                                    | `GET …/records/:id`                      |
| `create_records` | Up to 100 rows                             | `POST …/records`                         |
| `update_records` | Up to 100 rows, each with its id           | `PATCH …/records`                        |
| `delete_records` | Up to 100 rows by id                       | `DELETE …/records`                       |

A read-only token is offered the reading tools only. A write token that
forbids deletes is offered create and update, not `delete_records`.

Writes go through the same service as the grid: locked and signed rows,
reasons, client tables, the audit trail, and live updates all apply.
Schemas, views, members, and settings are out of reach.

## Errors

A tool that fails still answers HTTP 200 with a JSON-RPC result whose
`isError` is true (and a short JSON body with `code`). A call to a tool
the token is not offered (for example `create_records` on a read-only
token, or `delete_records` when deletes are off) is a JSON-RPC error
(`-32602`). Clients must read `isError` and the JSON-RPC `error`, not
only the HTTP status.

## A token an application asks for

Instead of a token someone pastes, an application an administrator
registered can ask a person for access to the bases they choose, and
use the token it gets here: [Applications (OAuth)](integrations/oauth.md).

## Clients

Claude Code:

```bash
claude mcp add --transport http anygriddb https://grid.example.org/mcp \
  --header "Authorization: Bearer ag_…"
```

Cursor, Claude Desktop, and clients that read an `mcpServers` file:

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

### Local model (Ollama and similar)

AnyGridDB does not speak to Ollama itself. Run a client that:

1. Holds the bearer token and calls `https://<instance>/mcp` (Streamable
   HTTP), and
2. Exposes those MCP tools to the model (Ollama's chat API with `tools`,
   or a desktop client that already speaks MCP).

A client that speaks only stdio can use a generic bridge to an HTTP
server, such as `mcp-remote`, then point Ollama or another runner at
that bridge. There is no `anygriddb mcp` command: it would need the
instance's database credentials on the machine that runs the AI.

Trust the instance's certificate (below) in the process that opens
`/mcp`. Prefer a read-only token, or a write token with deletes off,
until you know what the model will call.

## The instance's certificate

An instance without a certificate of its own uses its own authority
(ADR 0029). Download it from `https://<instance>/tls/authority.crt` and
start a Node-based client with `NODE_EXTRA_CA_CERTS=/path/authority.crt`,
or add it to the system's trusted authorities.

## Trying the REST API

Each base's API page (**API and documentation** in its menu) has a guide
per table, its OpenAPI document, and a **Try** tab that sends a request
with your session and shows the answer. A write there is real, and
recorded like any other.
