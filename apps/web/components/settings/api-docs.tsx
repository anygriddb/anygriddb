import { Button, cn } from "@anygriddb/ui";
import { Copy, ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useCopy } from "../../lib/clipboard";
import { useCatalog } from "../../lib/session";
import type { CatalogColumn } from "../../lib/types";
import { FIELD_LABELS, FieldIcon } from "../fields/field-meta";
import { useLingui } from "@lingui/react/macro";
import { raw } from "../../lib/known-text";
import { ApiConsole } from "./api-console";

type Tab = "guide" | "try" | "mcp";

function example(column: CatalogColumn): unknown {
  const options =
    (column.config as { options?: Array<{ name: string }> }).options ?? [];
  switch (column.fieldType) {
    case "number":
      return 42.5;
    case "rating":
      return 4;
    case "duration":
      return 5400;
    case "boolean":
      return true;
    case "date":
      return "2026-11-07";
    case "datetime":
      return "2026-11-07T09:30:00Z";
    case "single_select":
      return options[0]?.name ?? "Option";
    case "multi_select":
      return options.slice(0, 2).map((option) => option.name);
    case "email":
      return "ada@example.org";
    case "url":
      return "https://example.org";
    case "phone":
      return "+33 1 23 45 67 89";
    case "user":
      return ["<user id>"];
    case "attachment":
      return ["<attachment key>"];
    case "relation_one_to_many":
    case "relation_many_to_many":
      return ["<record id>"];
    default:
      return "Texte";
  }
}

function Code({ text }: { text: string }) {
  const { t } = useLingui();
  const copy = useCopy();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-foreground/95 p-3 text-xs text-background">
        {text}
      </pre>
      <Button
        size="xs"
        variant="outline"
        className="absolute top-2 right-2"
        aria-label={t`Copy`}
        onClick={() => copy(text)}
      >
        <Copy className="h-3 w-3" aria-hidden />
      </Button>
    </div>
  );
}

const WRITABLE = new Set([
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "email",
  "url",
  "phone",
  "rating",
  "duration",
  "user",
  "attachment",
  "relation_one_to_many",
  "relation_many_to_many",
]);

export function ApiDocs({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === baseId);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("guide");
  if (!base) return null;
  const origin = window.location.origin;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "guide", label: t`Guide` },
    { id: "try", label: t`Try it` },
    { id: "mcp", label: t`MCP (AI)` },
  ];
  const table =
    base.tables.find((item) => item.id === tableId) ?? base.tables[0];
  const writable =
    table?.columns.filter((column) => WRITABLE.has(column.fieldType)) ?? [];
  const sample = Object.fromEntries(
    writable.slice(0, 4).map((column) => [column.name, example(column)]),
  );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">
          {t`${{ name: base.name }} API`}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t`REST at ${{ url: `${origin}/api/v1` }}. Authenticate with a token: Authorization: Bearer ag_…`}{" "}
          <Link to="/settings" className="text-primary underline">
            {t`Create a token`}
          </Link>
        </p>
        <a
          className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline"
          href={`/api/v1/bases/${baseId}/openapi.json`}
          target="_blank"
          rel="noopener noreferrer"
        >
          OpenAPI 3.1 <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
      <div
        className="flex flex-wrap gap-1 border-b border-border pb-2"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === tab}
            onClick={() => setTab(item.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm",
              item.id === tab
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "mcp" ? <McpGuide origin={origin} /> : null}
      {tab !== "mcp" ? (
        <div className="flex flex-wrap gap-1">
          {base.tables.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTableId(item.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm",
                item.id === table?.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted",
              )}
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "try" && table ? (
        <ApiConsole key={table.id} tableId={table.id} sample={sample} />
      ) : null}
      {tab === "guide" && table ? (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 font-semibold">
              {t`${{ name: table.name }} fields`}
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">{t`Key`}</th>
                  <th>{t`Label`}</th>
                  <th>{t`Type`}</th>
                  <th>{t`Write`}</th>
                  <th>{t`Example`}</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr
                    key={column.name}
                    className="border-t border-border align-top"
                  >
                    <td className="py-1.5 font-mono text-xs">{column.name}</td>
                    <td>{column.label}</td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <FieldIcon fieldType={column.fieldType} />
                        {t(
                          FIELD_LABELS[column.fieldType] ??
                            raw(column.fieldType),
                        )}
                      </span>
                    </td>
                    <td>
                      {WRITABLE.has(column.fieldType) ? t`yes` : t`computed`}
                    </td>
                    <td className="font-mono text-xs">
                      {WRITABLE.has(column.fieldType)
                        ? JSON.stringify(example(column))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <h2 className="font-semibold">{t`Read rows`}</h2>
            <Code
              text={`curl -H "Authorization: Bearer $AG_TOKEN" \\\n  "${origin}/api/v1/tables/${table.id}/records?limit=50&sort=-${table.columns[0]?.name ?? "id"}"`}
            />
            <p className="text-xs text-muted-foreground">
              {t`Parameters: limit (1000 at most), offset, view, sort (list, - for descending), fields, search, fieldKey=label, filter (JSON tree).`}
            </p>
            <Code
              text={`curl -G -H "Authorization: Bearer $AG_TOKEN" "${origin}/api/v1/tables/${table.id}/records" \\\n  --data-urlencode 'filter={"conjunction":"and","conditions":[{"column":"${table.columns[0]?.name ?? "id"}","op":"is_not_empty"}]}'`}
            />
            <h2 className="font-semibold">{t`Create or update`}</h2>
            <Code
              text={`curl -X POST -H "Authorization: Bearer $AG_TOKEN" -H "Content-Type: application/json" \\\n  "${origin}/api/v1/tables/${table.id}/records" \\\n  -d '${JSON.stringify({ records: [{ fields: sample }], typecast: true })}'`}
            />
            <p className="text-xs text-muted-foreground">
              {t`PATCH takes the same shape with an id per row; DELETE takes ?records=id1,id2. 100 rows per call. X-Reason header for fields that require a reason.`}
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** How to connect an AI the operator runs: the endpoint, its clients. */
function McpGuide({ origin }: { origin: string }) {
  const { t } = useLingui();
  const endpoint = `${origin}/mcp`;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">{t`Connect an AI (MCP)`}</h2>
      <p className="text-sm text-muted-foreground">
        {t`AnyGridDB embeds no model: the AI you run (Claude, Cursor, Ollama with an MCP client…) connects to the instance's MCP server. It reads and writes rows with the token's rights, never more than yours; no administration, no schema. A read-only token offers it reading only.`}
      </p>
      <h3 className="text-sm font-medium">{t`Address (Streamable HTTP)`}</h3>
      <Code text={`${endpoint}\nAuthorization: Bearer ag_…`} />
      <h3 className="text-sm font-medium">Claude Code</h3>
      <Code
        text={`claude mcp add --transport http anygriddb ${endpoint} \\\n  --header "Authorization: Bearer ag_…"`}
      />
      <h3 className="text-sm font-medium">{t`Cursor, Claude Desktop, and other clients`}</h3>
      <Code
        text={JSON.stringify(
          {
            mcpServers: {
              anygriddb: {
                url: endpoint,
                headers: { Authorization: "Bearer ag_…" },
              },
            },
          },
          null,
          2,
        )}
      />
      <p className="text-xs text-muted-foreground">
        {t`If the instance uses its own certificate authority, tell the client about it: download it, then start the client with NODE_EXTRA_CA_CERTS pointing at that file.`}{" "}
        <a className="text-primary underline" href="/tls/authority.crt">
          authority.crt
        </a>
      </p>
      <p className="text-xs text-muted-foreground">
        {t`Tools: list_bases, list_tables, get_openapi, list_records, get_record, create_records, update_records, delete_records.`}
      </p>
    </section>
  );
}
