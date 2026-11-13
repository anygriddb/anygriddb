import { Button, cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { RotateCw, TriangleAlert } from "lucide-react";
import { hasReason, useErrorText } from "../../lib/errors";

/**
 * A page whose data could not be loaded: why, when the server said so,
 * and a way to try again, rather than a spinner that never stops while
 * the API restarts or the network is gone.
 */
export function LoadFailed(props: {
  error: unknown;
  onRetry: () => void;
  /** The whole window, before the app's frame exists. */
  fullScreen?: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center",
        props.fullScreen && "h-screen",
      )}
    >
      <TriangleAlert className="h-6 w-6 text-destructive" aria-hidden />
      <p className="max-w-md text-sm">
        {hasReason(props.error)
          ? t`This page could not be loaded: ${{ reason: errorText(props.error) }}`
          : t`This page could not be loaded. Check your connection, then try again.`}
      </p>
      <Button reads variant="outline" size="sm" onClick={props.onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        {t`Try again`}
      </Button>
    </div>
  );
}
