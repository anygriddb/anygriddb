import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";

/**
 * A private iCal address of a calendar view, for the person: a calendar
 * application subscribes to it. Its token shows once; renewing it stops
 * the old address, revoking stops it for good.
 */
export function CalendarFeedButton({ viewId }: { viewId: string }) {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feed = useQuery({
    ...api.catalog.calendarFeed.queryOptions({ viewId }),
    enabled: open,
  });
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.catalog.calendarFeed.queryKey({ viewId }),
    });
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const current = feed.data?.feed;
  const when = (date: Date | string | null | undefined) =>
    date ? new Date(date).toLocaleString(i18n.locale) : "";
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
        {t`Subscribe`}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setUrl(null);
        }}
      >
        <DialogContent
          title={t`Subscribe to this calendar`}
          description={t`A private address for your calendar application (Outlook, Google Calendar, Apple Calendar…). It shows what you can read of this view, from six months back to two years ahead. Keep it to yourself: whoever has it reads these rows.`}
        >
          <div className="flex flex-col gap-3 p-4 text-sm">
            {url ? (
              <>
                <p>{t`Copy this address now: it will not be shown again.`}</p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    aria-label={t`Calendar address`}
                    value={url}
                    onFocus={(event) => event.target.select()}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t`Copy the address`}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(url)
                        .then(() => toast.success(t`Address copied`));
                    }}
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </>
            ) : current ? (
              <p>
                {t`You have had an address since ${{ date: when(current.createdAt) }}.`}{" "}
                {current.lastUsedAt
                  ? t`Last read on ${{ date: when(current.lastUsedAt) }}.`
                  : t`It has not been read yet.`}
              </p>
            ) : feed.isSuccess ? (
              <p>{t`You have no address for this view yet.`}</p>
            ) : null}
          </div>
          <DialogFooter>
            {current ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await trpc.catalog.revokeCalendarFeed.mutate({ viewId });
                    setUrl(null);
                    toast.success(t`Address revoked`);
                  })
                }
              >
                {t`Revoke`}
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const created = await trpc.catalog.renewCalendarFeed.mutate({
                    viewId,
                  });
                  setUrl(created.url);
                })
              }
            >
              {current ? t`New address` : t`Create the address`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
