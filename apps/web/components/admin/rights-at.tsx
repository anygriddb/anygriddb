import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { downloadCsv } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { LoadFailed } from "../shell/load-failed";
import { useWhen } from "../../lib/i18n";

/**
 * The end of a calendar day in this browser's zone, as UTC. A day that
 * is not a real date is refused.
 */
export function endOfChosenDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const end = new Date(year, month - 1, date, 23, 59, 59, 999);
  if (
    end.getFullYear() !== year ||
    end.getMonth() !== month - 1 ||
    end.getDate() !== date
  ) {
    return null;
  }
  return end.toISOString();
}

/**
 * Rebuilds a person's roles from the change trail at the end of a chosen
 * day, with CSV export. Incomplete when the trail was purged before that
 * date.
 */
export function RightsAt({ userId }: { userId: string }) {
  const { t } = useLingui();
  const when = useWhen();
  const errorText = useErrorText();
  const api = useTRPC();
  const roleLabel = useRoleLabel();
  const [at, setAt] = useState(() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const date = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${date}`;
  });
  const atIso = endOfChosenDay(at);
  const report = useQuery({
    ...api.admin.access.rightsAt.queryOptions({
      userId,
      at: atIso ?? "1970-01-01T00:00:00.000Z",
    }),
    enabled: atIso !== null,
  });
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    if (!atIso) return;
    setExporting(true);
    try {
      const file = await trpc.admin.access.exportRightsAt.query({
        userId,
        at: atIso,
      });
      if (file.incomplete) {
        toast.error(t`The trail was purged before that date.`);
        return;
      }
      downloadCsv(`rights-at-${at}.csv`, file.csv);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border p-3 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rights-at">{t`Rights at the end of this day`}</Label>
          <Input
            id="rights-at"
            type="date"
            reads
            className="w-44"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          reads
          disabled={
            atIso === null || report.data?.incomplete === true || exporting
          }
          onClick={() => void exportCsv()}
        >
          {t`Export as CSV`}
        </Button>
      </div>
      {report.isError ? (
        <LoadFailed
          error={report.error}
          onRetry={() => void report.refetch()}
        />
      ) : null}
      {report.isLoading ? (
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
      ) : null}
      {report.data?.incomplete ? (
        <p className="text-warning">
          {t`The change trail no longer reaches this date (earliest kept ${{
            date: report.data.earliestKept
              ? when.instant(report.data.earliestKept)
              : "—",
          }}). The report cannot answer.`}
        </p>
      ) : null}
      {report.data && !report.data.incomplete ? (
        report.data.lines.length === 0 ? (
          <p className="text-muted-foreground">
            {t`No role on the trail for this person at that date.`}
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-sm border border-border">
            {report.data.lines.map((line) => (
              <li
                key={`${line.scope}:${line.scopeId}:${line.groupId ?? "direct"}`}
                className="flex flex-wrap justify-between gap-2 px-2 py-1.5"
              >
                <span>
                  {line.scope === "base" ? t`Base` : t`Table`}
                  {" · "}
                  {line.tableName ?? line.baseName ?? line.scopeId.slice(0, 8)}
                  {line.scope === "table" && line.baseName ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({line.baseName})
                    </span>
                  ) : null}
                  {line.groupName ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {t`through the group ${{ group: line.groupName }}`}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {roleLabel(line.role)}
                  {line.occurredAt ? ` · ${when.instant(line.occurredAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
