import type { PersonChannel, PersonEvent } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";

/**
 * What each kind of notice and each channel is called, on the account's
 * page and in Administration alike.
 */
export function usePersonEventLabels(): {
  events: Record<PersonEvent, string>;
  channels: Record<PersonChannel, string>;
} {
  const { t } = useLingui();
  return {
    events: {
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
    },
    channels: {
      in_app: t`In the app`,
      email_immediate: t`Email now`,
      email_daily: t`Daily digest`,
      email_weekly: t`Weekly digest`,
    },
  };
}
