/**
 * Tries the REST API from its documentation page: a request on one table,
 * sent with the reader's own session (the API takes it on this origin, as
 * it takes a token), and the answer as it came. Writes are real, audited
 * like any other. No third-party explorer: nothing leaves the instance.
 */
import { Button, Input, Label, Select, Textarea } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { RuledSection } from "../shell/notebook-page";

type ApiMethod = "list" | "get" | "create" | "update" | "delete";

/** The request a method makes on a table: verb, path with its query, body. */
export function apiRequest(
  tableId: string,
  method: ApiMethod,
  input: { query: string; recordId: string; body: string },
): { verb: string; path: string; body?: string } {
  const records = `/api/v1/tables/${tableId}/records`;
  const query = input.query.trim().replace(/^\?/, "");
  switch (method) {
    case "list":
      return { verb: "GET", path: query ? `${records}?${query}` : records };
    case "get":
      return {
        verb: "GET",
        path: `${records}/${encodeURIComponent(input.recordId.trim())}`,
      };
    case "create":
      return { verb: "POST", path: records, body: input.body };
    case "update":
      return { verb: "PATCH", path: records, body: input.body };
    case "delete":
      return {
        verb: "DELETE",
        path: `${records}?records=${encodeURIComponent(input.recordId.trim())}`,
      };
  }
}

type Answer = { status: number; ms: number; text: string };

export function ApiConsole(props: {
  tableId: string;
  /** A record to start a write from: the table's writable fields. */
  sample: Record<string, unknown>;
}) {
  const { t } = useLingui();
  const [method, setMethod] = useState<ApiMethod>("list");
  const [query, setQuery] = useState("limit=10");
  const [recordId, setRecordId] = useState("");
  const [body, setBody] = useState(() =>
    JSON.stringify(
      { records: [{ fields: props.sample }], typecast: true },
      null,
      2,
    ),
  );
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const request = apiRequest(props.tableId, method, { query, recordId, body });
  const writes = method === "create" || method === "update";

  async function send() {
    setBusy(true);
    const started = performance.now();
    try {
      const response = await fetch(request.path, {
        method: request.verb,
        credentials: "same-origin",
        headers: request.body ? { "content-type": "application/json" } : {},
        ...(request.body ? { body: request.body } : {}),
      });
      const text = await response.text();
      let shown = text;
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON: shown as it came.
      }
      setAnswer({
        status: response.status,
        ms: Math.round(performance.now() - started),
        text: shown,
      });
    } catch (cause) {
      setAnswer({
        status: 0,
        ms: Math.round(performance.now() - started),
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <RuledSection
      title={t`Try it`}
      description={t`The request goes out with your session, under your rights. A write is real, and recorded like any other.`}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="api-method">{t`Operation`}</Label>
          <Select
            id="api-method"
            value={method}
            onChange={(event) => setMethod(event.target.value as ApiMethod)}
          >
            <option value="list">{t`List rows (GET)`}</option>
            <option value="get">{t`Read a row (GET)`}</option>
            <option value="create">{t`Create rows (POST)`}</option>
            <option value="update">{t`Update rows (PATCH)`}</option>
            <option value="delete">{t`Delete rows (DELETE)`}</option>
          </Select>
        </div>
        {method === "list" ? (
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <Label htmlFor="api-query">{t`Parameters`}</Label>
            <Input
              id="api-query"
              className="font-mono text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="limit=10&sort=-name&search=acme"
            />
          </div>
        ) : null}
        {method === "get" || method === "delete" ? (
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <Label htmlFor="api-record">
              {method === "get" ? t`Row id` : t`Ids, separated by commas`}
            </Label>
            <Input
              id="api-record"
              className="font-mono text-xs"
              value={recordId}
              onChange={(event) => setRecordId(event.target.value)}
            />
          </div>
        ) : null}
        <Button
          onClick={() => void send()}
          disabled={
            busy ||
            ((method === "get" || method === "delete") && !recordId.trim())
          }
        >
          {t`Submit`}
        </Button>
      </div>
      {writes ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="api-body">
            {method === "update" ? t`Body (an id per row)` : t`Body`}
          </Label>
          <Textarea
            id="api-body"
            className="min-h-32 font-mono text-xs"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
      ) : null}
      <p className="font-mono text-xs break-all text-muted-foreground">
        {request.verb} {request.path}
      </p>
      {answer ? (
        <div className="flex flex-col gap-1" aria-live="polite">
          <p className="text-xs">
            <span
              className={
                answer.status >= 200 && answer.status < 300
                  ? "font-medium text-primary"
                  : "font-medium text-danger"
              }
            >
              {answer.status === 0 ? t`Network failure` : answer.status}
            </span>{" "}
            <span className="text-muted-foreground">
              {t`${{ ms: answer.ms }} ms`}
            </span>
          </p>
          <pre
            data-testid="api-answer"
            tabIndex={0}
            className="max-h-96 overflow-auto rounded-sm bg-foreground/95 p-3 text-xs text-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {answer.text}
          </pre>
        </div>
      ) : null}
    </RuledSection>
  );
}
