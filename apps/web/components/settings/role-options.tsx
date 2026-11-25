import { ROLES } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "./role-label";

/** The roles an administrator made (ADR 0128), which a base gives too. */
export function useMadeRoles() {
  const api = useTRPC();
  return useQuery(api.catalog.madeRoles.queryOptions());
}

/**
 * The options of a list that gives a role: the four, then the roles made
 * in Administration, each by its id. A made role is chosen as the four
 * are; the server refuses one that gives more than the giver holds.
 */
export function RoleOptions() {
  const { t } = useLingui();
  const roleLabel = useRoleLabel();
  const made = useMadeRoles();
  const roles = made.data?.roles ?? [];
  return (
    <>
      {ROLES.map((value) => (
        <option key={value} value={value}>
          {roleLabel(value)}
        </option>
      ))}
      {roles.length > 0 ? (
        <optgroup label={t`Roles made in Administration`}>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

/** The name of a list's value: one of the four, or a made role by its id. */
export function useRoleChoiceLabel() {
  const roleLabel = useRoleLabel();
  const made = useMadeRoles();
  return (value: string): string =>
    made.data?.roles.find((role) => role.id === value)?.name ??
    roleLabel(value);
}
