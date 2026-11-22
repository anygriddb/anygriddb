import { plural } from "@lingui/core/macro";
import { toast } from "sonner";

/** Says that some links did not come back with the rows just restored. */
export function sayLinksLeft(count: number): void {
  if (count === 0) return;
  toast.warning(
    plural(count, {
      one: "# link was not put back: the row on its other side is locked or signed.",
      other:
        "# links were not put back: the rows on their other side are locked or signed.",
    }),
  );
}

/** Says that some values no longer fit a field converted since the delete. */
export function sayValuesCleared(count: number): void {
  if (count === 0) return;
  toast.warning(
    plural(count, {
      one: "# value no longer fits its field, converted since: it came back empty, and stays in the row's history.",
      other:
        "# values no longer fit their fields, converted since: they came back empty, and stay in the rows' history.",
    }),
  );
}
