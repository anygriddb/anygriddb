import { Button } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { RuledSection } from "../shell/notebook-page";
import { ConfirmDialog } from "../shell/dialogs";

type Switch = "sessions" | "links" | "tokens";

/**
 * What an administrator does at once to the whole instance when an
 * account, a link, or a token may be in the wrong hands (ROADMAP #24).
 * Each asks to be confirmed, and lands on the sign-in trail.
 */
export function EmergencySection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.settings.queryOptions());
  const [asked, setAsked] = useState<Switch | null>(null);
  const linksOff = settings.data?.publicLinks === "off";

  async function run(action: () => Promise<string>) {
    try {
      toast.success(await action());
      await Promise.all(
        [api.admin.settings, api.admin.sessions, api.auth.instance].map(
          (procedure) =>
            queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const rows: Array<{
    id: Switch;
    label: string;
    hint: string;
    disabled?: boolean;
  }> = [
    {
      id: "sessions",
      label: t`Sign everyone else out`,
      hint: t`Every other session ends now, administrators' too. Yours stays open.`,
    },
    {
      id: "links",
      label: t`Turn public links off`,
      hint: linksOff
        ? t`Public links are off: no link to a view or a form opens.`
        : t`Every link to a view or a form stops opening at once. They open again when the policy below allows them.`,
      disabled: !settings.data || linksOff,
    },
    {
      id: "tokens",
      label: t`Revoke every API token`,
      hint: t`Scripts and AI clients that use one stop at once, yours too. A revoked token cannot be brought back: people make new ones.`,
    },
  ];

  return (
    <RuledSection
      title={t`In an emergency`}
      description={t`When an account, a link, or a token may be in the wrong hands: act on the whole instance at once.`}
    >
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0"
          >
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {row.hint}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="text-danger"
              disabled={row.disabled}
              onClick={() => setAsked(row.id)}
            >
              {row.label}
            </Button>
          </li>
        ))}
      </ul>
      {asked === "sessions" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setAsked(null)}
          title={t`Sign everyone else out?`}
          description={t`Every other session ends now, administrators' too. Your own stays open. API tokens keep working.`}
          confirmLabel={t`Sign out`}
          onConfirm={() =>
            run(async () => {
              await trpc.admin.endOtherSessions.mutate();
              return t`Everyone else is signed out`;
            })
          }
        />
      ) : null}
      {asked === "links" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setAsked(null)}
          title={t`Turn public links off?`}
          description={t`Every link to a view or a form stops opening at once, password or not. Nothing is deleted: they open again when the policy allows them.`}
          confirmLabel={t`Turn off`}
          onConfirm={() =>
            run(async () => {
              await trpc.admin.updateSettings.mutate({ publicLinks: "off" });
              return t`Public links are off`;
            })
          }
        />
      ) : null}
      {asked === "tokens" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setAsked(null)}
          title={t`Revoke every API token?`}
          description={t`Every token of every account stops working now, yours too: scripts, integrations, and AI clients that use one are refused. They cannot be brought back.`}
          confirmLabel={t`Revoke`}
          onConfirm={() =>
            run(async () => {
              const { count } = await trpc.admin.revokeAllTokens.mutate();
              return count === 0
                ? t`No API token to revoke`
                : plural(count, {
                    one: "# API token revoked",
                    other: "# API tokens revoked",
                  });
            })
          }
        />
      ) : null}
    </RuledSection>
  );
}
