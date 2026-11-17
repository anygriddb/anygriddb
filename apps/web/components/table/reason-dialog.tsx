import { useLingui } from "@lingui/react/macro";
import { PromptDialog } from "../shell/dialogs";

/**
 * The question a field that wants a reason asks before a change: closed
 * without an answer, it gives the change up.
 */
export function ReasonDialog({
  onAnswer,
}: {
  onAnswer: (reason: string | false) => void;
}) {
  const { t } = useLingui();
  return (
    <PromptDialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
      title={t`Reason for the change`}
      label={t`This field needs a reason, kept in the audit trail.`}
      submitLabel={t`Confirm`}
      onSubmit={onAnswer}
    />
  );
}
