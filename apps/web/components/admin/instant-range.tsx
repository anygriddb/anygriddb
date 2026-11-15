import { DatePicker, getLocalTimeZone, Label } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { fromDateValue, toDateValue } from "../../lib/dates";

/** The last millisecond of the minute a date field holds. */
export function endOfMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    return iso;
  }
  date.setUTCMilliseconds(59_999);
  return date.toISOString();
}

/**
 * A start and an end, to the minute, in the reader's zone. An inverted
 * pair is said under the fields; the page does not ask for it.
 */
export function InstantRange({
  from,
  to,
  invalid,
  onChange,
}: {
  from?: string;
  to?: string;
  invalid: boolean;
  onChange: (next: { from?: string; to?: string }) => void;
}) {
  const { t, i18n } = useLingui();
  const zone = getLocalTimeZone();
  const locale = i18n.locale === "fr" ? "fr-FR" : "en-GB";
  const field = (
    id: string,
    label: string,
    value: string | undefined,
    end: boolean,
  ) => (
    <div className="flex flex-col gap-1">
      <Label id={id}>{label}</Label>
      <DatePicker
        aria-labelledby={id}
        granularity="minute"
        locale={locale}
        className="w-56"
        value={toDateValue(value ?? "", true, zone)}
        onChange={(next) => {
          const iso = fromDateValue(next, true);
          const stored =
            iso === null ? undefined : end ? endOfMinute(iso) : iso;
          onChange(end ? { from, to: stored } : { from: stored, to });
        }}
      />
    </div>
  );
  return (
    <>
      {field("range-from", t`From`, from, false)}
      {field("range-to", t`To`, to, true)}
      {invalid ? (
        <p className="basis-full text-xs text-danger" role="alert">
          {t`The start is after the end.`}
        </p>
      ) : null}
    </>
  );
}
