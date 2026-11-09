import { Button, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc } from "../../lib/trpc";

/**
 * Reads a client's table again and brings its fields in line (ADR 0006):
 * new columns, changed types and lists of values, dropped columns. For
 * administrators, in the source's page and where a grid says the table
 * changed.
 */
export function RefreshFields(props: {
  tableId: string;
  onDone?: () => void;
  size?: "xs" | "sm";
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      const result = await trpc.admin.sources.refreshTable.mutate({
        tableId: props.tableId,
      });
      const parts = [
        result.added.length > 0
          ? plural(result.added.length, {
              one: `# field added`,
              other: `# fields added`,
            })
          : null,
        result.changed.length > 0
          ? plural(result.changed.length, {
              one: `# field updated`,
              other: `# fields updated`,
            })
          : null,
        result.removed.length > 0
          ? plural(result.removed.length, {
              one: `# field removed (in the trash)`,
              other: `# fields removed (in the trash)`,
            })
          : null,
      ].filter((part): part is string => part !== null);
      toast.success(
        parts.length > 0 ? parts.join(" · ") : t`The fields were up to date`,
      );
      await queryClient.invalidateQueries();
      props.onDone?.();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant="outline"
      size={props.size ?? "xs"}
      disabled={busy}
      onClick={() => void refresh()}
    >
      {busy ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
      {t`Refresh fields`}
    </Button>
  );
}
