import type { RelaxationKey } from "@anygriddb/core";
import { Button, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useWhen } from "../../lib/i18n";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { AdminTable, AdminTableHead } from "./admin-list";

type Relaxation = RouterOutputs["admin"]["relaxations"]["list"][number];

/** What each relaxation is, and what going back to strict does (ADR 0140). */
function useRelaxationWords() {
  const { t } = useLingui();
  const what: Record<RelaxationKey, string> = {
    "source.plaintext": t`Connects without TLS`,
    "notify.private_networks": t`Channels may call a private network`,
  };
  const strict: Record<RelaxationKey, string> = {
    "source.plaintext": t`The source connects over verified TLS again. If its database offers none, its tables stop answering until it does.`,
    "notify.private_networks": t`Channels, heartbeats and collectors on a private address are no longer called. Loopback and cloud metadata stay refused either way.`,
  };
  return { what, strict };
}

/**
 * Administration › Security › Relaxed requirements: every requirement an
 * administrator relaxed, with who did and when, and the way back to
 * strict. What is not listed is strict.
 */
export function RelaxationsPage() {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const when = useWhen();
  const words = useRelaxationWords();
  const list = useQuery(api.admin.relaxations.list.queryOptions());
  const [ending, setEnding] = useState<Relaxation | null>(null);

  async function backToStrict(relaxation: Relaxation) {
    await trpc.admin.relaxations.end.mutate({
      key: relaxation.key,
      ...(relaxation.source ? { sourceId: relaxation.source.id } : {}),
    });
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.admin.relaxations.pathKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: api.admin.sources.list.queryKey(),
      }),
    ]);
  }

  return (
    <RuledSection
      title={t`Relaxed requirements`}
      description={t`What an administrator relaxed on this instance, each after confirming what it exposes. Everything not listed here is strict. Going back to strict holds from the next connection or call.`}
    >
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <p className="rounded-sm border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
          {t`Nothing is relaxed: every requirement is strict.`}
        </p>
      ) : (
        <AdminTable
          role="region"
          aria-label={t`Relaxed requirements`}
          tabIndex={0}
          className="focus-visible:outline-2 focus-visible:outline-ring"
        >
          <AdminTableHead>
            <tr>
              <th className="px-3 py-2 text-left">{t`Requirement`}</th>
              <th className="px-3 py-2 text-left">{t`Relaxed for`}</th>
              <th className="px-3 py-2 text-left">{t`Relaxed by`}</th>
              <th className="px-3 py-2 text-left">{t`Since`}</th>
              <th className="px-3 py-2 text-right">
                <span className="sr-only">{t`Actions`}</span>
              </th>
            </tr>
          </AdminTableHead>
          <tbody>
            {list.data.map((relaxation) => (
              <tr
                key={`${relaxation.key}:${relaxation.source?.id ?? ""}`}
                className="border-t border-border"
              >
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {words.what[relaxation.key]}
                </th>
                <td className="px-3 py-2">
                  {relaxation.source?.name ?? t`The instance`}
                </td>
                <td className="px-3 py-2">
                  {relaxation.enabledBy?.name ?? t`A deleted account`}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {when.instant(relaxation.enabledAt)}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setEnding(relaxation)}
                  >
                    {t`Return to strict`}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        title={t`Return to strict?`}
        description={ending ? words.strict[ending.key] : ""}
        confirmLabel={t`Return to strict`}
        onConfirm={async () => {
          if (ending) await backToStrict(ending);
          setEnding(null);
        }}
      />
    </RuledSection>
  );
}
