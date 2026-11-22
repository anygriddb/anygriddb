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
