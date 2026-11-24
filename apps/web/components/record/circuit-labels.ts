import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";

/**
 * The words for the shipped circuits' templates, states and transitions,
 * by key, in the reader's language. The database keeps one name for each,
 * in English; a key not shipped keeps that name.
 */
const TEMPLATES: Record<string, MessageDescriptor> = {
  compliance: msg`Compliance`,
  simple_review: msg`Simple review`,
  dual_approval: msg`Dual approval`,
};

const STATES: Record<string, MessageDescriptor> = {
  draft: msg`Draft`,
  submitted: msg`Submitted`,
  locked: msg`Locked`,
  signed: msg`Signed`,
  in_review: msg`In review`,
  approved_once: msg`Approved once`,
  approved: msg`Approved`,
};

const TRANSITIONS: Record<string, MessageDescriptor> = {
  submit: msg`Submit`,
  lock: msg`Lock`,
  unlock: msg`Unlock`,
  sign: msg`Sign`,
  approve: msg`Approve`,
  approve_first: msg`First approval`,
  approve_second: msg`Second approval`,
  reject: msg`Reject`,
};

const WORDS = {
  template: TEMPLATES,
  state: STATES,
  transition: TRANSITIONS,
} as const;

/** What a template, a state or a transition is called for this reader. */
export function circuitWord(
  i18n: I18n,
  kind: keyof typeof WORDS,
  item: { key: string; label?: string; name?: string },
): string {
  const word = WORDS[kind][item.key];
  return word ? i18n._(word) : (item.label ?? item.name ?? item.key);
}
