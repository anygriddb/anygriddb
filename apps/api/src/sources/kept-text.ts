/**
 * What a client's column kept of a text. An engine converts a text to the
 * column's code page without a word: each character it lacks becomes `?`
 * or a near one (`Ā` becomes `A`), one for one, and the others stay. Only
 * that is refused: a trigger that rewrites the value is the client's rule.
 */

function isAscii(character: string): boolean {
  return character.charCodeAt(0) < 0x80;
}

/** The text's UTF-16 units: a code page may turn a pair into two `?`. */
function unitsOf(text: string): string[] {
  return Array.from({ length: text.length }, (_, index) => text.charAt(index));
}

/** Whether only non-ASCII characters differ, and not merely by their case. */
function replacedOneForOne(
  sent: readonly string[],
  kept: readonly string[],
): boolean {
  if (sent.length !== kept.length) return false;
  let replaced = false;
  for (const [index, character] of sent.entries()) {
    const held = kept[index] ?? "";
    if (held === character) continue;
    if (isAscii(character)) return false;
    if (held.toLowerCase() !== character.toLowerCase()) replaced = true;
  }
  return replaced;
}

/** Whether `kept` is `sent` with characters its code page lacks replaced. */
export function lostToCodePage(sent: string, kept: unknown): boolean {
  if (typeof kept !== "string") return false;
  // A CHAR column pads with spaces.
  const wanted = sent.trimEnd();
  const held = kept.trimEnd();
  if (wanted === held) return false;
  return (
    replacedOneForOne(Array.from(wanted), Array.from(held)) ||
    replacedOneForOne(unitsOf(wanted), unitsOf(held))
  );
}
