import type { NumberFormat } from "../../lib/format";

/**
 * A value on the chart's axis: short past ten thousand, with its
 * currency or its percent sign when the measured field has one.
 */
export function axisFormat(
  tag: string,
  fieldFormat: NumberFormat | undefined,
  percent: boolean,
): (value: number) => string {
  const money: Intl.NumberFormatOptions =
    fieldFormat?.style === "currency"
      ? { style: "currency", currency: fieldFormat.currency ?? "EUR" }
      : {};
  const make = (options: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(tag, { ...money, ...options });
    } catch {
      // A currency code Intl does not take: the number alone.
      return new Intl.NumberFormat(tag, options);
    }
  };
  const short = make({ notation: "compact", maximumFractionDigits: 1 });
  const whole = make({ minimumFractionDigits: 0, maximumFractionDigits: 3 });
  const sign = percent || fieldFormat?.style === "percent" ? " %" : "";
  return (value) =>
    `${(Math.abs(value) >= 10_000 ? short : whole).format(value)}${sign}`;
}
