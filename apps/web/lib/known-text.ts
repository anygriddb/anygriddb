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
  Companies: msg`Companies`,
  Contacts: msg`Contacts`,
  Deals: msg`Deals`,
  Projects: msg`Projects`,
  Tasks: msg`Tasks`,
  Suppliers: msg`Suppliers`,
  Products: msg`Products`,
  Tickets: msg`Tickets`,

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
  "Invalid email settings": msg`Invalid email settings`,
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
