/**
 * Whether a refresh keeps the type a person chose for a client's column.
 * A link stays a link. A type chosen in AnyGridDB stays while the column's
 * own type is unchanged. A column whose type changed is followed.
 */
import type { FieldType } from "@anygriddb/core";

export function followedField(input: {
  link: boolean;
  currentType: FieldType;
  currentExternal: string | null;
  clientType: FieldType;
  clientExternal: string;
}): { fieldType: FieldType; keepConfig: boolean } {
  if (input.link) return { fieldType: input.currentType, keepConfig: true };
  const chosen =
    input.currentExternal === input.clientExternal &&
    input.currentType !== input.clientType;
  if (chosen) return { fieldType: input.currentType, keepConfig: true };
  return { fieldType: input.clientType, keepConfig: false };
}
