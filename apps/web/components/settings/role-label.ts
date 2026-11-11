import type { Role } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";

/** A base role's name, as base settings and Administration show it. */
export function useRoleLabel() {
  const { t } = useLingui();
  return (role: Role | null | undefined) =>
    role === "owner"
      ? t`Owner`
      : role === "editor"
        ? t`Editor`
        : role === "commenter"
          ? t`Comment`
          : role === "viewer"
            ? t`Viewer`
            : "—";
}
