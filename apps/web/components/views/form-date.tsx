import { DatePicker } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useRef, useState, type FocusEvent } from "react";
import {
  dateFieldLocale,
  dateFormatOf,
  editZone,
  fromDateValue,
  sameDate,
  startingPoint,
  toDateValue,
} from "../../lib/dates";
import { useLocale } from "../../lib/i18n";
import { readTypedDate, UNREADABLE_DATE } from "../../lib/typed-date";
import type { CatalogColumn } from "../../lib/types";

/**
 * A date of a form, of a public link, or of a new row. What was typed is
 * read as the field is left, before the field moves a date that does not
 * exist to one that does: the form then holds `UNREADABLE_DATE`, says why
 * under the field, and refuses to send it.
 */
export function FormDate({
  id,
  labelId,
  describedBy,
  required,
  invalid,
  column,
  value,
  onChange,
}: {
  id: string;
  labelId: string;
  describedBy: string | undefined;
  required: boolean;
  /** Its answer is missing or refused, as the form says under it. */
  invalid?: boolean;
  column: CatalogColumn;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const withTime = column.fieldType === "datetime";
  const format = dateFormatOf(column);
  const zone = editZone(format);
  const box = useRef<HTMLDivElement>(null);
  const calendarOpen = useRef(false);
  const [problem, setProblem] = useState("");
  // While what was typed is refused, the field keeps the last real value:
  // given another, it would drop the text the person has to correct.
  const [lastGood, setLastGood] = useState(
    value === UNREADABLE_DATE ? "" : value,
  );
  if (value !== UNREADABLE_DATE && value !== lastGood) setLastGood(value);
  const shown = value === UNREADABLE_DATE ? lastGood : value;
  // One object for one value: a new one would reset the typed segments.
  const [held, setHeld] = useState(() => ({
    text: shown,
    date: toDateValue(shown, withTime, zone),
  }));
  if (held.text !== shown) {
    setHeld({ text: shown, date: toDateValue(shown, withTime, zone) });
  }
  const { date } = held;

  function onLeave(event: FocusEvent<HTMLDivElement>) {
    const root = box.current;
    if (!root || calendarOpen.current) return;
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    const typed = readTypedDate(root, { withTime, zone, held: date });
    if (typed.state === "unread") return;
    if (typed.state === "partial" || typed.state === "impossible") {
      // The field must not go on to correct what was typed.
      event.stopPropagation();
      setProblem(
        typed.state === "partial"
          ? t`This date is not complete.`
          : t`“${{ date: typed.text }}” does not exist.`,
      );
      onChange(UNREADABLE_DATE);
      return;
    }
    setProblem("");
    if (typed.state === "empty") {
      // Left empty: what the field holds is its own to change.
      if (value === UNREADABLE_DATE) onChange("");
      return;
    }
    const written = fromDateValue(typed.value, withTime);
    if (value === UNREADABLE_DATE || !sameDate(value, written, withTime)) {
      onChange(written ?? "");
    }
  }

  return (
    <div ref={box} onBlurCapture={onLeave}>
      <DatePicker
        id={id}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        isRequired={required}
        isInvalid={
          invalid === true || (value === UNREADABLE_DATE && problem !== "")
        }
        value={date}
        onChange={(next) => {
          setProblem("");
          onChange(fromDateValue(next, withTime) ?? "");
        }}
        onOpenChange={(open) => {
          calendarOpen.current = open;
        }}
        granularity={withTime ? "minute" : "day"}
        hourCycle={
          format.hour12 === undefined ? undefined : format.hour12 ? 12 : 24
        }
        hideTimeZone={!format.timeZone}
        placeholderValue={withTime ? startingPoint(zone) : undefined}
        locale={dateFieldLocale(locale, format.format)}
      />
      {value === UNREADABLE_DATE && problem ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
