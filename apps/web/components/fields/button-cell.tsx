import { renderTemplate, type ButtonConfig } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { toast } from "sonner";
import { cellDisplay } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { canWrite, type CatalogColumn, type RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

/** The URL a button opens for a row, or null unless it is http(s). */
export function buttonUrl(
  template: string,
  values: Readonly<Record<string, string>>,
): string | null {
  const encoded = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      encodeURIComponent(value),
    ]),
  );
  try {
    const url = new URL(renderTemplate(template, encoded));
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** A button cell: opens its URL for the row, or runs the automations behind it. */
export function ButtonCell({
  column,
  row,
}: {
  column: CatalogColumn;
  row: RowItem;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const table = useTable();
  const config = (column.config as { button?: ButtonConfig }).button;
  if (!config) return null;
  const runs = config.action === "run_automation";
  const disabled = runs && !canWrite(table.role);

  async function press() {
    if (config?.action === "open_url" && config.url) {
      const values: Record<string, string> = {
        record_id: row.id,
        table: table.table.name,
      };
      for (const item of table.columns) {
        values[item.name] = cellDisplay(
          row[item.name as keyof RowItem],
          item,
          table.locale,
          table.people,
        );
      }
      const url = buttonUrl(config.url, values);
      if (!url) {
        toast.error(t`Invalid link`);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const { results } = await trpc.automations.pressButton.mutate({
        tableId: table.table.id,
        rowId: row.id,
        column: column.name,
      });
      const failed = results.find((result) => result.status === "failed");
      if (failed)
        toast.error(
          t`Failed: ${{ error: failed.error ? errorText(failed.error) : "—" }}`,
        );
      else if (results.every((result) => result.status === "skipped")) {
        toast.info(t`Already running`);
      } else toast.success(t`Done`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void press();
      }}
      className={cn(
        `opt-${config.color ?? "blue"}`,
        "max-w-full truncate rounded px-2 py-0.5 text-xs font-medium hover:brightness-95 disabled:opacity-50",
      )}
    >
      {config.label}
    </button>
  );
}
