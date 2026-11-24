import { Checkbox } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import type { PersonChannel, PersonEvent } from "@anygriddb/core";
import { useStepUp } from "./step-up";
import { trpc, useTRPC } from "../../lib/trpc";
import { useErrorText } from "../../lib/errors";
import { RuledSection } from "../shell/notebook-page";

const CHANNELS: PersonChannel[] = [
  "in_app",
  "email_immediate",
  "email_daily",
  "email_weekly",
];

/**
 * Instance defaults for person notification preferences (ADR 0123).
 */
export function NotificationDefaultsSection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const defaults = useQuery(api.admin.notificationDefaults.get.queryOptions());

  const labels: Partial<Record<PersonEvent, string>> = {
    mention: t`Mention`,
    reply: t`Reply`,
    assigned: t`Assignment`,
    automation: t`Automation failure`,
    webhook_disabled: t`Webhook disabled`,
    row_changed: t`Locked row changed outside`,
    role_given: t`Role given`,
    owner_named: t`Owner named`,
    account_locked: t`Account locked (admins)`,
    admin_access: t`Emergency access`,
    acting_as: t`Acting as`,
    password_changed: t`Password changed`,
    factors_removed: t`Factors removed`,
    sso_linked: t`SSO linked`,
    locked: t`Own account locked`,
    inactive_soon: t`Inactivity warning`,
    inactive_disabled: t`Inactivity disable`,
  };
  const channelLabel: Record<PersonChannel, string> = {
    in_app: t`App`,
    email_immediate: t`Email`,
    email_daily: t`Daily`,
    email_weekly: t`Weekly`,
  };

  return (
    <>
      {stepUp.dialog}
      <RuledSection
        title={t`Person notification defaults`}
        description={t`What each account inherits until they change their own preferences. Security notices keep immediate email.`}
        className="text-sm"
      >
        {!defaults.data ? (
          <p className="text-muted-foreground">{t`Loading…`}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t`Event`}</th>
                  {CHANNELS.map((channel) => (
                    <th key={channel} className="px-2 py-2 font-medium">
                      {channelLabel[channel]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {defaults.data.events.map((event) => (
                  <tr key={event.id} className="border-b border-border/60">
                    <td className="py-2 pr-3">
                      {labels[event.id] ?? event.id}
                    </td>
                    {CHANNELS.map((channel) => {
                      const checked = event.channels.includes(channel);
                      const locked = event.required.includes(channel);
                      return (
                        <td key={channel} className="px-2 py-2">
                          <Checkbox
                            aria-label={`${labels[event.id] ?? event.id} — ${channelLabel[channel]}`}
                            checked={checked}
                            disabled={locked}
                            onChange={(change) => {
                              const on = change.target.checked;
                              const next = on
                                ? [...new Set([...event.channels, channel])]
                                : event.channels.filter(
                                    (item) => item !== channel,
                                  );
                              void (async () => {
                                try {
                                  if (!(await stepUp.ensure())) return;
                                  await trpc.admin.notificationDefaults.set.mutate(
                                    {
                                      event: event.id,
                                      channels: next,
                                    },
                                  );
                                  await queryClient.invalidateQueries({
                                    queryKey:
                                      api.admin.notificationDefaults.get.queryKey(),
                                  });
                                  toast.success(t`Saved`);
                                } catch (error) {
                                  toast.error(errorText(error));
                                }
                              })();
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </RuledSection>
    </>
  );
}
