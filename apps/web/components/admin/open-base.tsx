import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { PromptDialog } from "../shell/dialogs";
import { useInvalidateCatalog } from "../shell/sidebar";
import { useStepUp } from "./step-up";

type Opening = {
  userId: string;
  displayName: string;
  reason: string;
  expiresAt: string | Date;
};

const hour = (when: string | Date) =>
  new Date(when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Reading a base without being a member of it (ADR 0074). Administration
 * shows a base's shape, never its rows: an administrator who must read
 * them opens the base for an hour, with a reason its owners are told. The
 * page says who has it open now, and ends the administrator's own opening.
 */
export function OpenBase({
  baseId,
  members,
  open,
}: {
  baseId: string;
  members: readonly { userId: string }[];
  open: readonly Opening[];
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const invalidateCatalog = useInvalidateCatalog();
  const session = useSession();
  const stepUp = useStepUp();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = session.data?.id;
  const isAdmin = session.data?.isAdmin === true;
  const member = members.some((item) => item.userId === me);
  const mine = open.find((item) => item.userId === me);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.admin.baseOverview.get.queryKey({ baseId }),
      }),
      invalidateCatalog(),
    ]);
  }
  async function close() {
    setBusy(true);
    try {
      await trpc.admin.baseOverview.close.mutate({ baseId });
      await refresh();
      toast.success(t`The base is closed to you again`);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby="base-open">
      <h3 id="base-open" className="text-sm font-semibold">
        {t`Reading the base`}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t`Administration shows what a base is made of, never its rows. To read them without being a member, an administrator opens the base for an hour and says why: its owners are told at once, in the app and by email, and it is written to the change trail. Nothing can be changed meanwhile; rows taken out as a file are on the trail too.`}
      </p>
      {open.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-sm border border-border text-sm">
          {open.map((item) => (
            <li key={item.userId} className="px-3 py-2">
              <span className="font-medium">{item.displayName}</span>{" "}
              {t`reads it until ${{ until: hour(item.expiresAt) }}`}
              <span className="block text-xs text-muted-foreground">
                {item.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {!isAdmin ? null : member ? (
        <p className="text-sm text-muted-foreground">
          {t`You are a member of this base: open it as its members do.`}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {mine ? (
            <>
              <Button asChild size="sm">
                <Link to="/b/$baseId" params={{ baseId }}>
                  {t`Go to the base`}
                </Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void close()}
              >
                {t`Close it now`}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (await stepUp.ensure()) setAsking(true);
                })()
              }
            >
              {t`Open it to read, for an hour`}
            </Button>
          )}
        </div>
      )}
      {stepUp.dialog}
      <PromptDialog
        open={asking}
        onOpenChange={setAsking}
        title={t`Open this base to read it?`}
        label={t`Reason`}
        submitLabel={t`Open for an hour`}
        multiline
        onSubmit={async (reason) => {
          try {
            await trpc.admin.baseOverview.open.mutate({ baseId, reason });
            await refresh();
            toast.success(t`The base is open to you for an hour`);
          } catch (cause) {
            toast.error(errorText(cause));
            throw cause;
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          {t`Its owners are told now, with your name and this reason. You will read every table of the base and change nothing.`}
        </p>
      </PromptDialog>
    </section>
  );
}
