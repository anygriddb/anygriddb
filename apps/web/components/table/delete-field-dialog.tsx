import { useLingui } from "@lingui/react/macro";
import { useTrashDays } from "../../lib/trash";
import type { CatalogColumn } from "../../lib/types";
import { isLinkField } from "../fields/field-meta";
import { ConfirmDialog } from "../shell/dialogs";

/** Asks before a field goes to the trash, naming what goes with it. */
export function DeleteFieldDialog({
  column,
  onClose,
  onDelete,
}: {
  column: CatalogColumn;
  onClose: () => void;
  onDelete: (column: CatalogColumn) => Promise<void>;
}) {
  const { t } = useLingui();
  const days = useTrashDays();
  return (
    <ConfirmDialog
      open
      danger
      onOpenChange={(open) => !open && onClose()}
      title={t`Delete the field “${{ name: column.label }}”?`}
      description={
        isLinkField(column.fieldType)
          ? t`The field, and its inverse field if any, go to the base's trash for ${{ days }} days with their links.`
          : t`The field goes to the base's trash for ${{ days }} days with its values.`
      }
      confirmLabel={t`Delete`}
      onConfirm={() => onDelete(column)}
    />
  );
}
