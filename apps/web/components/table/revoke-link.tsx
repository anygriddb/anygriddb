import { useLingui } from "@lingui/react/macro";
import { trpc } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";

/**
 * Asks before a public link is revoked: everyone who has it loses it at
 * once, and a link is not made again, another has another address. One
 * click did it, on a view's links and on a base's.
 */
export function RevokeLink(props: {
  /** The link about to be revoked; none, and nothing is asked. */
  shareId: string | null;
  onClose: () => void;
  /** Once it is revoked: the list is read again. */
  onRevoked: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const { shareId } = props;
  if (shareId === null) return null;
  return (
    <ConfirmDialog
      open
      danger
      onOpenChange={(open) => !open && props.onClose()}
      title={t`Revoke this link?`}
      description={t`It stops opening at once, for everyone who has it. A link is not made again: another has another address.`}
      confirmLabel={t`Revoke`}
      onConfirm={async () => {
        await trpc.catalog.revokeShare.mutate({ shareId });
        await props.onRevoked();
      }}
    />
  );
}
