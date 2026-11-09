import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { RotateCw, TriangleAlert } from "lucide-react";
import { reasonOf, useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { RefreshFields } from "../admin/refresh-fields";

/**
 * A view whose rows could not be read: what went wrong, said plainly, and
 * a way to try again. A client's database may be down, slow, or refuse
 * the query; the view never waits for ever.
 */
export function RowsError(props: {
  error: unknown;
  onRetry: () => void;
  /** The client's table, for an administrator to bring its fields in line. */
  tableId?: string;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const session = useSession();
  const changed =
    reasonOf(props.error).code === "source_schema_changed" &&
    session.data?.isAdmin === true &&
    props.tableId !== undefined;
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <TriangleAlert className="h-6 w-6 text-destructive" aria-hidden />
      <p className="max-w-md text-sm">
        {t`The rows could not be read: ${{ reason: errorText(props.error) }}`}
      </p>
      <div className="flex gap-2">
        {changed && props.tableId ? (
          <RefreshFields
            tableId={props.tableId}
            size="sm"
            onDone={props.onRetry}
          />
        ) : null}
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          <RotateCw className="h-4 w-4" aria-hidden />
          {t`Try again`}
        </Button>
      </div>
    </div>
  );
}
