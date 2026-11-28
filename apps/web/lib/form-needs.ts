import { useState } from "react";

/**
 * Something a form needs before it is sent: a field to fill in, a choice
 * to make. `missing` says whether it is still wanting, `say` what to do
 * about it, and `field` the id of the control that takes the keyboard.
 */
export type Need = { missing: boolean; say: string; field?: string };

/**
 * What the browser's own check asked of an email address, said by the app
 * instead: something on each side of an @, and no space. The server says
 * the rest.
 */
export function looksLikeAddress(text: string): boolean {
  const at = text.indexOf("@");
  return at > 0 && at < text.length - 1 && !/\s/.test(text);
}

/** The first need still wanting, or null when the form may go. */
export function unmetNeed(needs: readonly Need[]): Need | null {
  return needs.find((need) => need.missing) ?? null;
}

/**
 * What a form needs, said when it is sent rather than by a greyed button,
 * which says nothing of why. The form's button stays live (but while it
 * is busy); its submit asks `met` first, which says the first need still
 * wanting (`said`, drawn where the form says its refusals), marks its
 * field (`invalid`, for `aria-invalid`) and moves the keyboard there.
 */
export function useNeeds() {
  const [unmet, setUnmet] = useState<Need | null>(null);
  return {
    said: unmet?.say ?? null,
    invalid: (field: string) => (unmet?.field === field ? true : undefined),
    met(needs: readonly Need[]): boolean {
      const need = unmetNeed(needs);
      setUnmet(need);
      if (need?.field) document.getElementById(need.field)?.focus();
      return need === null;
    },
    /** Says nothing more: the page moved to another form. */
    clear: () => setUnmet(null),
  };
}
