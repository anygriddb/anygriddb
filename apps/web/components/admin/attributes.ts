import {
  SCIM_ENTERPRISE_FIELDS,
  type ScimEnterpriseField,
  trimEndRun,
} from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";

/** The fields of SCIM's enterprise extension an attribute may take. */
export const SCIM_FIELDS = SCIM_ENTERPRISE_FIELDS;

/**
 * The key an attribute takes from its name (ADR 0142): its letters and
 * digits, accents dropped, words joined by `_`, at most 40 characters; none
 * when the name does not start with a letter from A to Z.
 */
export function attributeKeyOf(name: string): string | null {
  const words = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((word) => word !== "");
  const key = trimEndRun(words.join("_").slice(0, 40), "_");
  return /^[a-z][a-z0-9_]*$/.test(key) ? key : null;
}

/** The field a list's value names, or none for "Not sent". */
export function scimFieldOf(value: string): ScimEnterpriseField | null {
  return SCIM_FIELDS.find((field) => field === value) ?? null;
}

/** A field of the enterprise extension, as an administrator reads it. */
export function useScimFieldLabel(): (field: ScimEnterpriseField) => string {
  const { t } = useLingui();
  return (field) =>
    field === "department"
      ? t`Department`
      : field === "division"
        ? t`Division`
        : field === "organization"
          ? t`Organization`
          : t`Cost center`;
}
