import type { Given, Held, MadeRole } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";

/**
 * A role's name, as base settings and Administration show it: one of the
 * four in the reader's language, a made role by the name its maker gave
 * it (ADR 0128), and roles held together joined.
 */
export function useRoleLabel() {
  const { t } = useLingui();
  const shipped = (role: string): string | null =>
    role === "owner"
      ? t`Owner`
      : role === "editor"
        ? t`Editor`
        : role === "commenter"
          ? t`Commenter`
          : role === "viewer"
            ? t`Viewer`
            : role === "contributor"
              ? t`Contributor`
              : role === "validator"
                ? t`Validator`
                : role === "reader"
                  ? t`Reader`
                  : null;
  return (role: Held | MadeRole | string | null | undefined): string => {
    if (role == null) return "—";
    // A notice names a made role by its name: it is no key of the four.
    if (typeof role === "string") return shipped(role) ?? role;
    if ("made" in role) {
      return [
        ...(role.role ? [shipped(role.role) ?? role.role] : []),
        ...role.shipped.map((key) => shipped(key) ?? key),
        ...role.made.map((made) => made.name),
      ].join(" + ");
    }
    return role.name;
  };
}

/** A role as a list's value: one of the four by its key, a made role by its id. */
export function givenValue(given: Given | null | undefined): string {
  if (given == null) return "";
  return typeof given === "string" ? given : given.id;
}
