# Connecting an AI (MCP)

AnyGridDB serves the [Model Context Protocol](https://modelcontextprotocol.io)
so that an AI you run reads and writes your rows: Claude, Cursor, or a local
model behind an MCP client. AnyGridDB embeds no model and calls no outside
service (ADR 0040).

## Endpoint and token

- Address: `https://<instance>/mcp` (Streamable HTTP).
- Authentication: `Authorization: Bearer ag_…`, a token created in
  **Settings → Jetons d'API**. A session cookie is not accepted.
- Rights: the lower of the token's scope (its bases, read-only or not) and
  its owner's roles, field and row rules included. A read-only token is
  offered the reading tools only; prefer one to explore.
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

Writes go through the same service as the grid: locked and signed rows,
reasons, client tables, the audit trail, and live updates all apply.
Schemas, views, members, and settings are out of reach.

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

A client that speaks only stdio can use a generic bridge to an HTTP
server, such as `mcp-remote`. There is no `anygriddb mcp` command: it
would need the instance's database credentials on the machine that runs
the AI.

## The instance's certificate

An instance without a certificate of its own uses its own authority
(ADR 0029). Download it from `https://<instance>/tls/authority.crt` and
start a Node-based client with `NODE_EXTRA_CA_CERTS=/path/authority.crt`,
or add it to the system's trusted authorities.

## Trying the REST API

Each base's API page (**API et documentation** in its menu) has a guide per table, its
OpenAPI document, and an **Essayer** tab that sends a request with your
session and shows the answer. A write there is real, and recorded like
any other.
