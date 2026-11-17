import { OPTION_COLORS, type OptionColor } from "@anygriddb/core";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@anygriddb/ui";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { useId, useState } from "react";

/** The colours an option, a button, or a rule takes, as people name them. */
export const OPTION_COLOR_NAMES: Record<OptionColor, MessageDescriptor> = {
  gray: msg`Grey`,
  red: msg`Red`,
  orange: msg`Orange`,
  yellow: msg`Yellow`,
  green: msg`Green`,
  teal: msg`Teal`,
  blue: msg`Blue`,
  purple: msg`Purple`,
  pink: msg`Pink`,
  brown: msg`Brown`,
};

/** The colour a setting holds, or grey when it holds none of the ten. */
function optionColor(value: string): OptionColor {
  return OPTION_COLORS.find((color) => color === value) ?? "gray";
}

/**
 * One colour chosen among the ten: radio buttons, each as large as a
 * pointer needs (WCAG 2.5.8) and named by its colour. The chosen one is
 * ticked, so that the choice does not rest on the colour alone.
 */
export function OptionColorSwatches(props: {
  /** What the colour is of: the group's name. */
  label: string;
  value: string;
  onChange: (color: OptionColor) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const group = useId();
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={cn("flex flex-wrap gap-1", props.className)}
    >
      {OPTION_COLORS.map((color) => (
        <label
          key={color}
          className={cn(
            `opt-${color}`,
            "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-transparent has-[:checked]:border-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
          )}
        >
          <input
            type="radio"
            name={group}
            aria-label={t(OPTION_COLOR_NAMES[color])}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            checked={props.value === color}
            onChange={() => props.onChange(color)}
          />
          {props.value === color ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : null}
        </label>
      ))}
    </div>
  );
}

/**
 * The same choice behind one swatch, where a line has no room for ten: the
 * swatch shows the colour held and says its name, and opens the ten.
 */
export function OptionColorButton(props: {
  /** What the colour is of. */
  label: string;
  value: string;
  onChange: (color: OptionColor) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const held = optionColor(props.value);
  const name = t(OPTION_COLOR_NAMES[held]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`${{ label: props.label }}: ${{ color: name }}`}
          className={cn(
            `opt-${held}`,
            "h-6 w-6 shrink-0 rounded-full border border-strong-border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        />
      </PopoverTrigger>
      <PopoverContent aria-label={props.label} className="w-auto">
        {/* Five to a line: two lines of five. */}
        <OptionColorSwatches
          className="w-[8.5rem]"
          label={props.label}
          value={held}
          onChange={(color) => {
            props.onChange(color);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
