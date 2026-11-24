/**
 * Events meant for a person, and the channels they may choose (ADR 0123).
 * Declared once from the inventory of what the product already tells people:
 * the bell's kinds, the security mails, and the notices that currently
 * bypass `notify()`. Instance channels (ADR 0092) are a different catalogue.
 */
import { z } from "zod";

/** How a person may receive one event. */
export const PERSON_CHANNELS = [
  "in_app",
  "email_immediate",
  "email_daily",
  "email_weekly",
] as const;

export type PersonChannel = (typeof PERSON_CHANNELS)[number];

/**
 * Every person-facing event the product can raise. A row in the bell uses
 * the same id as `notification_kind` where one exists; security mails that
 * never wrote a bell row use their own ids (`locked`, `password_changed`, …).
 */
export const PERSON_EVENTS = [
  "mention",
  "reply",
  "assigned",
  "automation",
  "webhook_disabled",
  "row_changed",
  "role_given",
  "owner_named",
  "account_locked",
  "admin_access",
  "acting_as",
  "password_changed",
  "factors_removed",
  "sso_linked",
  "locked",
  "inactive_soon",
  "inactive_disabled",
] as const;

export type PersonEvent = (typeof PERSON_EVENTS)[number];

export type PersonEventDefinition = {
  id: PersonEvent;
  /**
   * Channels the person may not remove. Empty: every channel is optional.
   * Security and emergency notices keep at least immediate email so the
   * person always hears what happened to their account or their data.
   */
  required: readonly PersonChannel[];
  /** Built-in defaults until an administrator sets instance defaults. */
  defaults: readonly PersonChannel[];
  /**
   * Whether the event is about a base or a table the person may mute.
   * Account and security events are never muted that way.
   */
  scoped: boolean;
};

/**
 * Catalogue. Required channels, and why they stay on:
 *
 * - `locked`, `password_changed`, `factors_removed`, `sso_linked`,
 *   `inactive_soon`, `inactive_disabled`: the only warning that someone
 *   else is changing the account, or that it will be disabled. Turning
 *   them off would hide a compromise.
 * - `admin_access`, `acting_as`: an administrator used emergency powers
 *   on the person's base or as the person. Accountability requires the
 *   notice; the person may still silence the bell, not the mail.
 *
 * Invitations and the administrator's operational broadcast stay outside
 * this catalogue: the former carries the only link to join; the latter
 * ignores preferences on purpose (ADR 0052).
 */
export const PERSON_EVENT_CATALOG: ReadonlyArray<PersonEventDefinition> = [
  {
    id: "mention",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "reply",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "assigned",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "automation",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "webhook_disabled",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "row_changed",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "role_given",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "owner_named",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "account_locked",
    required: [],
    defaults: ["in_app", "email_immediate"],
    scoped: false,
  },
  {
    id: "admin_access",
    required: ["email_immediate"],
    defaults: ["in_app", "email_immediate"],
    scoped: true,
  },
  {
    id: "acting_as",
    required: ["email_immediate"],
    defaults: ["in_app", "email_immediate"],
    scoped: false,
  },
  {
    id: "password_changed",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
  {
    id: "factors_removed",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
  {
    id: "sso_linked",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
  {
    id: "locked",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
  {
    id: "inactive_soon",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
  {
    id: "inactive_disabled",
    required: ["email_immediate"],
    defaults: ["email_immediate"],
    scoped: false,
  },
];

const byId = new Map(
  PERSON_EVENT_CATALOG.map((event) => [event.id, event] as const),
);

export function personEvent(id: PersonEvent): PersonEventDefinition {
  const found = byId.get(id);
  if (!found) throw new Error(`unknown person event: ${id}`);
  return found;
}

/** Whether a person may turn this channel off for this event. */
export function channelIsOptional(
  event: PersonEvent,
  channel: PersonChannel,
): boolean {
  return !personEvent(event).required.includes(channel);
}

/** Events whose preferences migrate from the old `notify_by_email` flag. */
export const EMAIL_MIGRATION_EVENTS: readonly PersonEvent[] =
  PERSON_EVENT_CATALOG.filter(
    (event) =>
      event.scoped &&
      event.defaults.includes("email_immediate") &&
      !event.required.includes("email_immediate"),
  ).map((event) => event.id);

export const personChannelSchema = z.enum(PERSON_CHANNELS);
export const personEventSchema = z.enum(PERSON_EVENTS);

export const personChannelsSchema = z
  .array(personChannelSchema)
  .max(PERSON_CHANNELS.length)
  .transform((channels) => [...new Set(channels)]);

/**
 * Merges a person's choice with the event's required channels. Required
 * ones are always kept, even when the person clears the list.
 */
export function withRequiredChannels(
  event: PersonEvent,
  chosen: readonly PersonChannel[],
): PersonChannel[] {
  const required = personEvent(event).required;
  return [...new Set([...required, ...chosen])];
}

/** Whether a channel list includes an email path. */
export function wantsEmail(channels: readonly PersonChannel[]): boolean {
  return channels.some(
    (channel) =>
      channel === "email_immediate" ||
      channel === "email_daily" ||
      channel === "email_weekly",
  );
}
