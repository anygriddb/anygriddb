import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Upload } from "lucide-react";
import type { emptyTableHint } from "./empty-table-hint-model";

/** What an empty grid says under its last line (`emptyTableHint`). */
export function EmptyTableHint({
  hint,
  canImport,
  onImport,
}: {
  hint: ReturnType<typeof emptyTableHint>;
  canImport: boolean;
  onImport: () => void;
}) {
  const { t } = useLingui();
  if (hint === "nothing-matches") {
    return (
      <p className="text-sm text-muted-foreground">
        {t`No row matches this view's filters or search.`}
      </p>
    );
  }
  if (hint === "copy-pending") {
    return (
      <p className="text-sm text-muted-foreground">
        {t`The copy has not arrived. The table stays empty until then.`}
      </p>
    );
  }
  if (hint !== "start") return null;
  // The grid's own last line adds a row: the hint points to it rather
  // than offering a second button that does the same.
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm font-medium">{t`No rows yet.`}</p>
      <p className="text-sm text-muted-foreground">
        {canImport
          ? t`Add a first row on the line above, or bring the rows of a CSV, Excel, or JSON file.`
          : t`Add a first row on the line above.`}
      </p>
      {canImport ? (
        <Button size="sm" variant="outline" onClick={onImport}>
          <Upload className="h-4 w-4" aria-hidden />
          {t`Import a file`}
        </Button>
      ) : null}
    </div>
  );
}
