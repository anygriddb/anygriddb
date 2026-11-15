/**
 * Whether a refresh keeps a field as it is, or follows the client's
 * column. A link stays a link. A list of values the client's database
 * defines (an enum, a check) is followed: it may have changed, and it
 * says more than any choice here. Otherwise, while the column's own type
 * is unchanged, the field keeps what was chosen in AnyGridDB, its type
 * and its settings; a column whose type changed is followed.
 */
import type { FieldType } from "@anygriddb/core";

const LISTS = new Set<FieldType>(["single_select", "multi_select"]);

export function followedField(input: {
  link: boolean;
  currentType: FieldType;
  currentExternal: string | null;
  clientType: FieldType;
  clientExternal: string;
}): { fieldType: FieldType; keepConfig: boolean } {
  if (input.link) return { fieldType: input.currentType, keepConfig: true };
  const unchanged =
    input.currentExternal === input.clientExternal &&
    !LISTS.has(input.clientType);
  if (unchanged) return { fieldType: input.currentType, keepConfig: true };
  return { fieldType: input.clientType, keepConfig: false };
}
