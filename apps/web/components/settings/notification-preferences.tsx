import { Checkbox } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import type { PersonChannel, PersonEvent } from "@anygriddb/core";
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
 * Per-event channels and mutes for the signed-in person (ADR 0126).
 */
export function NotificationPreferences() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const preferences = useQuery(api.notifications.preferences.queryOptions());

  const labels: Record<PersonEvent, string> = {
    mention: t`Mention in a comment`,
    reply: t`Reply to your comment`,
    assigned: t`Assigned to a row`,
    automation: t`Automation you authored failed`,
    webhook_disabled: t`Webhook you created was disabled`,
    row_changed: t`Locked row changed outside`,
    role_given: t`Role given on a base you own`,
    owner_named: t`Someone made an owner`,
    account_locked: t`Another account locked (administrators)`,
    admin_access: t`Administrator opened a base you own`,
    acting_as: t`Administrator acting as you`,
    password_changed: t`Your password changed`,
    factors_removed: t`Your second factors removed`,
    sso_linked: t`Your account linked to an identity provider`,
    locked: t`Your account locked`,
    inactive_soon: t`Your account will soon be disabled`,
    inactive_disabled: t`Your account was disabled for inactivity`,
  };
  const channelLabel: Record<PersonChannel, string> = {
    in_app: t`In the app`,
    email_immediate: t`Email now`,
    email_daily: t`Daily digest`,
    email_weekly: t`Weekly digest`,
  };

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const events = preferences.data?.events ?? [];
  const mutes = preferences.data?.mutes ?? [];

  return (
    <>
      <RuledSection
        title={t`Notifications`}
        description={t`Choose, for each kind of notice, where you want to hear it. Some security notices cannot leave email.`}
      >
        {!preferences.data ? (
          <p className="text-sm text-muted-foreground">{t`Loading…`}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
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
                {events.map((event) => (
                  <tr key={event.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 align-middle">
                      {labels[event.id]}
                      {event.required.length > 0 ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t`Required on email`}
                        </span>
                      ) : null}
                    </td>
                    {CHANNELS.map((channel) => {
                      const checked = event.channels.includes(channel);
                      const locked = event.required.includes(channel);
                      return (
                        <td key={channel} className="px-2 py-2 align-middle">
                          <Checkbox
                            aria-label={`${labels[event.id]} — ${channelLabel[channel]}`}
                            checked={checked}
                            disabled={locked || !preferences.data}
                            onChange={(change) => {
                              const on = change.target.checked;
                              const next = on
                                ? [...new Set([...event.channels, channel])]
                                : event.channels.filter(
                                    (item) => item !== channel,
                                  );
                              void run(async () => {
                                await trpc.notifications.setPreference.mutate({
                                  event: event.id,
                                  channels: next,
                                });
                                await queryClient.invalidateQueries({
                                  queryKey:
                                    api.notifications.preferences.queryKey(),
                                });
                              });
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
      <RuledSection
        title={t`Muted places`}
        description={t`No mention, reply, assignment, or similar notice from these bases or tables. Account security notices still arrive.`}
      >
        {mutes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t`Nothing muted. Mute a noisy table from its settings later; for now remove a mute here.`}
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {mutes.map((mute) => (
              <li
                key={mute.id}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span>
                  {mute.tableName
                    ? `${mute.baseName ?? "—"} / ${mute.tableName}`
                    : (mute.baseName ?? "—")}
                </span>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() =>
                    void run(async () => {
                      await trpc.notifications.removeMute.mutate({
                        id: mute.id,
                      });
                      await queryClient.invalidateQueries({
                        queryKey: api.notifications.preferences.queryKey(),
                      });
                    })
                  }
                >
                  {t`Remove`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
    </>
  );
}
