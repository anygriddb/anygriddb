/**
 * A whole number between bounds, such as a rating (React Aria's
 * NumberField, ADR 0012): a spin button that says its bounds, changed by
 * the arrows or typed. Not for exact decimals, which it would read as
 * floats (ADR 0023): those stay text.
 */
import { Input as AriaInput, NumberField } from "react-aria-components";
import { cn } from "./cn";

export function IntegerField(props: {
  /** Null when empty. */
  value: number | null;
  onChange: (value: number | null) => void;
  minValue: number;
  maxValue: number;
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <NumberField
      value={props.value ?? Number.NaN}
      onChange={(value) => props.onChange(Number.isNaN(value) ? null : value)}
      minValue={props.minValue}
      maxValue={props.maxValue}
      step={1}
      formatOptions={{ maximumFractionDigits: 0 }}
      autoFocus={props.autoFocus}
      aria-label={props["aria-label"]}
      className="contents"
    >
      <AriaInput className={cn("outline-none", props.className)} />
    </NumberField>
  );
}
