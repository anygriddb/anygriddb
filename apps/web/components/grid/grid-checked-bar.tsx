import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/**
 * Over the grid while rows are ticked in its margin: how many, and what
 * is done to them all.
 */
export function CheckedRowsBar(props: {
  count: number;
  onDeselect: () => void;
  /** Copies them; unset where rows cannot be added. */
  onDuplicate: (() => void) | undefined;
  /** Deletes them; unset where rows cannot be deleted. */
  onDelete: (() => void) | undefined;
}) {
  const { t } = useLingui();
  return (
    <div className="absolute top-1 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-border bg-card px-3 py-1.5 text-sm shadow-lg">
      <span>
        {plural(props.count, {
          one: "# row selected",
          other: "# rows selected",
        })}
      </span>
      <button
        type="button"
        className="rounded px-2 py-0.5 hover:bg-muted"
        onClick={props.onDeselect}
      >
        {t`Deselect`}
      </button>
      {props.onDuplicate ? (
        <button
          type="button"
          className="rounded px-2 py-0.5 hover:bg-muted"
          onClick={props.onDuplicate}
        >
          {t`Duplicate`}
        </button>
      ) : null}
      {props.onDelete ? (
        <button
          type="button"
          className="rounded px-2 py-0.5 text-danger hover:bg-muted"
          onClick={props.onDelete}
        >
          {t`Delete`}
        </button>
      ) : null}
    </div>
  );
}
