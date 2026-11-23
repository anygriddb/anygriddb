/**
 * Words the server sends as values, not as errors: base template names,
 * webhook and automation outcomes, row statuses. Each one has a message
 * here; a value this file does not know shows as it is.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** A text with no translation: it shows as it is. */
export function raw(text: string): MessageDescriptor {
  return { id: text, message: text };
}

const KNOWN: Record<string, MessageDescriptor> = {
  // Base templates (packages/core/src/templates.ts).
  CRM: msg`CRM`,
  "Project management": msg`Project management`,
  Inventory: msg`Inventory`,
  "Issue tracking": msg`Issue tracking`,
  "Companies, contacts, and deals, with a kanban pipeline.": msg`Companies, contacts, and deals, with a kanban pipeline.`,
  "Projects and tasks, with a timeline and a status board.": msg`Projects and tasks, with a timeline and a status board.`,
  "Products, suppliers, and reorder points.": msg`Products, suppliers, and reorder points.`,
  "Tickets with severity, assignee, and a report form.": msg`Tickets with severity, assignee, and a report form.`,
  Events: msg`Events`,
  "Sessions on a calendar, their venues, and a form where attendees register.": msg`Sessions on a calendar, their venues, and a form where attendees register.`,
  Hiring: msg`Hiring`,
  "Open positions and their candidates, moved through the stages on a board.": msg`Open positions and their candidates, moved through the stages on a board.`,
  Companies: msg`Companies`,
  Contacts: msg`Contacts`,
  Deals: msg`Deals`,
  Projects: msg`Projects`,
  Tasks: msg`Tasks`,
  Suppliers: msg`Suppliers`,
  Products: msg`Products`,
  Tickets: msg`Tickets`,
  Sessions: msg`Sessions`,
  Venues: msg`Venues`,
  Attendees: msg`Attendees`,
  Positions: msg`Positions`,
  Candidates: msg`Candidates`,

  // Webhook deliveries and automation steps.
  Timeout: msg`Timeout`,
  "Blocked target": msg`Blocked target (private or internal address)`,
  "Unknown host": msg`Unknown host`,
  "Connection refused": msg`Connection refused`,
  "TLS error": msg`TLS error`,
  "Network error": msg`Network error`,
  "Webhook disabled": msg`Webhook disabled after too many failures`,
  "Loop limit": msg`Stopped: automation loop`,
  "Rate limit": msg`Stopped: too many runs a minute`,
  "Delayed too long": msg`Dropped: it waited more than a day for its turn`,
  "Invalid email settings": msg`Invalid email settings`,
  "Scripts disabled": msg`Scripts in automations are turned off on this instance`,
  "Script took too long": msg`The script took too long and was stopped`,
  "Script used too much memory": msg`The script used too much memory and was stopped`,
  "Script stopped": msg`The script was stopped`,
  "Not configured": msg`Not configured`,

  // Row statuses.
  draft: msg`Draft`,
  submitted: msg`Submitted`,
  locked: msg`Locked`,
  signed: msg`Signed`,

  // Service health.
  listening: msg`Listening`,
  reconnecting: msg`Reconnecting…`,
};

export function knownText(value: string): MessageDescriptor | undefined {
  return Object.hasOwn(KNOWN, value) ? KNOWN[value] : undefined;
}

/** The message of a value the server sends, or the value itself. */
export function known(value: string): MessageDescriptor {
  return knownText(value) ?? raw(value);
}
