import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useTrashActions } from "../../lib/trash";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogColumn } from "../../lib/types";

/**
 * What a field's menu changes in the table itself, each change followed
 * by a new read of the catalog: the field made primary, copied with its
 * values, or sent to the trash.
 */
export function useFieldChanges(input: {
  tableId: string;
  /** Reads the rows again: they hold the fields' values. */
  refreshRows: () => void;
}) {
  const { tableId, refreshRows } = input;
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { trashed } = useTrashActions();
  const readCatalog = () =>
    queryClient.invalidateQueries({ queryKey: api.catalog.list.queryKey() });
  const failed = (cause: unknown) => toast.error(errorText(cause));

  const makePrimary = (column: CatalogColumn) => {
    void trpc.catalog.setPrimaryColumn
      .mutate({ tableId, name: column.name })
      .then(readCatalog)
      .catch(failed);
  };
  const duplicate = (column: CatalogColumn) => {
    void trpc.catalog.duplicateColumn
      .mutate({ tableId, name: column.name })
      .then(async (created) => {
        await readCatalog();
        refreshRows();
        if (created.skipped > 0) {
          toast.warning(
            plural(created.skipped, {
              one: "# locked row was not copied",
              other: "# locked rows were not copied",
            }),
          );
        }
      })
      .catch(failed);
  };
  const remove = async (column: CatalogColumn) => {
    try {
      await trpc.catalog.deleteColumn.mutate({ tableId, name: column.name });
      await readCatalog();
      refreshRows();
      trashed(t`Field moved to the trash`, "column", column.id);
    } catch (cause) {
      failed(cause);
    }
  };
  return { readCatalog, makePrimary, duplicate, remove };
}
