import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Spinner,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { sayLinksLeft, sayValuesCleared } from "./restored-links";
import type { ReasonAnswer } from "./use-reason";
import { useWhen } from "../../lib/i18n";
import { Refusal, useRefusal } from "../shell/dialogs";

/**
 * The rows deleted from a table, which a person brings back: all of them
 * for those who manage it, their own for the others.
 */
export function RowTrashDialog({
  tableId,
  askReason,
  onClose,
  onRestored,
}: {
  tableId: string;
  /** Why the rows come back, where a field asks for a reason. */
  askReason: () => Promise<ReasonAnswer>;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useLingui();
  const when = useWhen();
  const errorText = useErrorText();
  const refusal = useRefusal();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const trash = useQuery(api.rows.trash.queryOptions({ tableId, limit: 100 }));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // One restore at a time, a second click on the button included.
  const busy = useRef(false);
  async function restore() {
    refusal.clear();
    try {
      const reason = await askReason();
      if (reason === false) return;
      const { linksNotRestored, valuesCleared } =
        await trpc.rows.restore.mutate({
          tableId,
          rowIds: [...picked],
          reason,
        });
      sayLinksLeft(linksNotRestored);
      sayValuesCleared(valuesCleared);
      toast.success(
        plural(picked.size, {
          one: "# row restored",
          other: "# rows restored",
        }),
      );
      setPicked(new Set());
      onRestored();
      await queryClient.invalidateQueries({
        queryKey: api.rows.trash.queryKey({ tableId, limit: 100 }),
      });
    } catch (cause) {
      refusal.say(cause);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t`Row trash`}
        description={
          trash.data?.own
            ? t`The rows you deleted come back as drafts, with their original number. Rows others deleted are not listed here.`
            : t`Deleted rows come back as drafts, with their original number.`
        }
      >
        {trash.isLoading ? <Spinner /> : null}
        {trash.error ? (
          <p role="alert" className="text-sm text-danger">
            {errorText(trash.error)}
          </p>
        ) : null}
        <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
          {(trash.data?.rows ?? []).map((item) => (
            <li key={item.rowId} className="py-1.5 text-sm">
              {/* The row's name is the box's: a click on either ticks it. */}
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={picked.has(item.rowId)}
                  onChange={(event) =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.rowId);
                      else next.delete(item.rowId);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="text-xs text-muted-foreground">
                  {item.deletedBy} · {when.instant(item.deletedAt)}
                </span>
              </label>
            </li>
          ))}
          {trash.data?.rows.length === 0 ? (
            <li className="py-4 text-sm text-muted-foreground">
              {t`The trash is empty.`}
            </li>
          ) : null}
        </ul>
        <Refusal text={refusal.text} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t`Close`}
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              void restore().finally(() => {
                busy.current = false;
              });
            }}
          >
            {t`Restore`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
