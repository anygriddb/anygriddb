/**
 * How the screens read what a person types or pastes: with the decimal
 * mark of their language and their time zone, and what they are told when
 * a value is refused.
 */
import type { CellRefusal, DecimalMark } from "@anygriddb/core";
import { getLocalTimeZone } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";

type Locale = "fr" | "en";

/** What a value typed or pasted by this reader is read with. */
export function readingIn(locale: Locale): {
  decimalMark: DecimalMark;
  timeZone: string;
} {
  // `1,234` is a thousand and more in English, a little over one in French.
  return {
    decimalMark: locale === "fr" ? "," : ".",
    timeZone: getLocalTimeZone(),
  };
}

/** What a person is told about a value refused for a field. */
export function useRefusedText(): (
  label: string,
  refused?: CellRefusal,
) => string {
  const { t } = useLingui();
  return useCallback(
    (label: string, refused?: CellRefusal) => {
      switch (refused?.code) {
        case "value_too_long":
          return t`“${{ field: label }}” holds at most ${{ limit: refused.limit }} characters`;
        case "ambiguous_number":
          return t`“${{ field: label }}”: this number reads two ways. Write it without a thousands separator`;
        default:
          return t`Invalid value for ${{ field: label }}`;
      }
    },
    [t],
  );
}
