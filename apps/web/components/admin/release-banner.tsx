import { Button } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

/**
 * Opt-in update notice (ADR 0048): shown only in Administration when a
 * newer release was found and not dismissed.
 */
export function ReleaseBanner() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const notice = useQuery({
    ...api.admin.releaseStatus.queryOptions(),
    refetchInterval: 60_000,
  });
  if (!notice.data?.notify || !notice.data.status) return null;
  const { latest, url } = notice.data.status;
  const dismiss = async () => {
    try {
      await trpc.admin.dismissRelease.mutate();
      await queryClient.invalidateQueries({
        queryKey: api.admin.releaseStatus.queryKey(),
      });
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <div
      role="status"
      className="mt-4 flex flex-wrap items-center gap-2 rounded-sm border border-warning/40 bg-warning-surface px-3 py-2 text-sm"
    >
      <p className="flex-1">
        <a
          className="underline underline-offset-2"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          {t`AnyGridDB ${{ latest }} is available`}
        </a>
        {" · "}
        {t`Read the release notes before you upgrade.`}
      </p>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t`Dismiss`}
        onClick={() => void dismiss()}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
