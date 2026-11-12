import { Button, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { datedName, downloadCsv } from "../../lib/download";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

const ACTIONS = [
  "insert",
  "update",
  "delete",
  "submit",
  "lock",
  "unlock",
  "sign",
  "catalog",
] as const;

/** The change trail: what was written, by whom, from where. */
export function ChangesTrail() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const session = useSession();
  const isAdmin = session.data?.isAdmin === true;
  const api = useTRPC();
  const [action, setAction] = useState<(typeof ACTIONS)[number] | "">("");
  const [source, setSource] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const log = useQuery(
    api.admin.audit.queryOptions({
      action: action || undefined,
      source: source || undefined,
      before,
      limit: 50,
    }),
  );
  const actionLabel = (value: string) =>
    ({
      insert: t`Creation`,
      update: t`Edit`,
      delete: t`Delete`,
      submit: t`Submission`,
      lock: t`Lock`,
      unlock: t`Unlock`,
      sign: t`Signature`,
      catalog: t`Structure`,
    })[value] ?? value;
  async function exportCsv() {
    try {
      const file = await trpc.admin.exportAudit.mutate({
        action: action || undefined,
        source: source || undefined,
      });
      downloadCsv(datedName("anygriddb-audit", "csv"), file.csv);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">{t`Action`}</Label>
          <Select
            id="audit-action"
            className="w-44"
            value={action}
            onChange={(event) => {
              setAction(event.target.value as typeof action);
              setCursors([]);
            }}
          >
            <option value="">{t`All`}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-source">{t`Source`}</Label>
          <Input
            id="audit-source"
            className="w-44"
            placeholder="web, api, import, automation…"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setCursors([]);
            }}
          />
        </div>
        {isAdmin ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" aria-hidden />
            {t`Export as CSV`}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t`The log shows who changed which fields. Values stay in each row's history, behind the table's access rights.`}
      </p>
      {log.isLoading ? <Spinner /> : null}
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-2 py-1.5">{t`Date`}</th>
              <th className="px-2 py-1.5">{t`Author`}</th>
              <th className="px-2 py-1.5">{t`Table`}</th>
              <th className="px-2 py-1.5">{t`Action`}</th>
              <th className="px-2 py-1.5">{t`Fields`}</th>
              <th className="px-2 py-1.5">{t`Reason`}</th>
              <th className="px-2 py-1.5">{t`Source`}</th>
            </tr>
          </thead>
          <tbody>
            {log.data?.events.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-3 text-muted-foreground">
                  {t`No change matches. Every write to a base, its fields, and its roles shows here, with who made it.`}
                </td>
              </tr>
            ) : null}
            {(log.data?.events ?? []).map((event) => (
              <tr key={event.id} className="border-t border-border align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {date(event.occurredAt)}
                </td>
                <td className="px-2 py-1.5">{event.userName ?? "—"}</td>
                <td className="px-2 py-1.5">
                  {event.tableName
                    ? `${event.baseName ?? ""} / ${event.tableName}`
                    : "—"}
                  {event.recordId ? (
                    <span className="block font-mono text-[10px] text-muted-foreground">
                      {event.recordId.slice(0, 8)}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">{actionLabel(event.action)}</td>
                <td className="px-2 py-1.5">
                  {event.fields.join(", ") || "—"}
                </td>
                <td className="px-2 py-1.5">{event.reason ?? "—"}</td>
                <td className="px-2 py-1.5">{event.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={cursors.length === 0}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {t`Newer`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!log.data?.next}
          onClick={() =>
            log.data?.next &&
            setCursors((current) => [...current, log.data.next as string])
          }
        >
          {t`Older`}
        </Button>
      </div>
    </div>
  );
}
