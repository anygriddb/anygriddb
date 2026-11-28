/**
 * A short text field's mask (ADR 0141): `#` a digit, `A` a letter from A
 * to Z in either case, `*` a digit or such a letter, `\` the next
 * character as itself, and every other character itself. A value fits
 * when it matches the mask character by character, whole. A mask is read
 * in one pass over the value: what it costs to check grows with the
 * value's length alone, unlike an expression a person types.
 */

import { ceilingOf } from "./limits";

/** The longest mask a field keeps. */
export const MAX_MASK_LENGTH = ceilingOf("field.mask_chars");

type Slot = "digit" | "letter" | "either" | { literal: string };

const DIGIT = /^[0-9]$/;
const LETTER = /^[A-Za-z]$/;

/** The mask's slots, one per character of a value; undefined if it ends on a lone `\`. */
function slotsOf(mask: string): Slot[] | undefined {
  const slots: Slot[] = [];
  const characters = Array.from(mask);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\\") {
      const next = characters[index + 1];
      if (next === undefined) return undefined;
      slots.push({ literal: next });
      index += 1;
    } else if (character === "#") slots.push("digit");
    else if (character === "A") slots.push("letter");
    else if (character === "*") slots.push("either");
    else slots.push({ literal: character });
  }
  return slots;
}

/** Whether a text is a mask a field may keep: one slot at least, nothing left dangling. */
export function isMask(mask: string): boolean {
  if (mask.length === 0 || mask.length > MAX_MASK_LENGTH) return false;
  // A control character would be a slot nobody can type or see.
  if (
    Array.from(mask).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return false;
  }
  const slots = slotsOf(mask);
  return slots !== undefined && slots.length > 0;
}

function fits(slot: Slot, character: string): boolean {
  if (slot === "digit") return DIGIT.test(character);
  if (slot === "letter") return LETTER.test(character);
  if (slot === "either") {
    return DIGIT.test(character) || LETTER.test(character);
  }
  return slot.literal === character;
}

/** Whether a value fits the mask, character by character, whole. */
export function fitsMask(mask: string, value: string): boolean {
  const slots = slotsOf(mask);
  if (!slots) return false;
  const characters = Array.from(value);
  return (
    characters.length === slots.length &&
    slots.every((slot, index) => fits(slot, characters[index] ?? ""))
  );
}

/** The mask as a regular expression's source, for the API's description. */
export function maskPattern(mask: string): string {
  const slots = slotsOf(mask) ?? [];
  const body = slots
    .map((slot) =>
      slot === "digit"
        ? "[0-9]"
        : slot === "letter"
          ? "[A-Za-z]"
          : slot === "either"
            ? "[0-9A-Za-z]"
            : // The characters that mean something in an expression, and
              // no other: a validator that reads patterns as Unicode
              // refuses an escape a character does not need (`\-`).
              slot.literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
    )
    .join("");
  return `^${body}$`;
}
