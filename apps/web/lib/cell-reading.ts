/**
 * How the screens read what a person types or pastes: with the decimal
 * mark of their language and their time zone, and what they are told when
 * a value is refused.
 */
import type { CellRefusal, DayOrder, DecimalMark } from "@anygriddb/core";
import { getLocalTimeZone } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";

type Locale = "fr" | "en";

/** What a value is read with: a reader's language, or a link's canonical text. */
export type Reading = {
  decimalMark?: DecimalMark;
  dayOrder?: DayOrder;
  timeZone: string;
};

/**
 * What a value typed or pasted by this reader is read with. `1,234` is a
 * thousand and more in English, a little over one in French. French puts
 * the day first; English is written both ways, so it settles no date.
 */
export function readingIn(locale: Locale): Reading {
  return locale === "fr"
    ? { decimalMark: ",", dayOrder: "day-first", timeZone: getLocalTimeZone() }
    : { decimalMark: ".", timeZone: getLocalTimeZone() };
}

/**
 * What a value given by a link or the page is read with: it was not written
 * in the reader's language, so its point is a decimal point.
 */
export function readingGiven(): Reading {
  return { timeZone: getLocalTimeZone() };
}

/** A number as an editor shows it: with the decimal mark of the language. */
export function editableNumber(text: string, locale: Locale): string {
  return locale === "fr" ? text.replace(".", ",") : text;
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
        case "ambiguous_point":
          return t`“${{ field: label }}”: with a comma for decimals, a point here reads two ways. Write it 1234 or 1,234`;
        case "ambiguous_date":
          return t`“${{ field: label }}”: this date reads two ways. Write it YYYY-MM-DD, or set the field's date format`;
        default:
          return t`Invalid value for ${{ field: label }}`;
      }
    },
    [t],
  );
}
