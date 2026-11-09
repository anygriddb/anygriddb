/**
 * A date, or a date and time, typed segment by segment in the reader's
 * language or picked from a calendar (React Aria, ADR 0012). Screen
 * readers name each segment (day, month, hour), the arrows change it,
 * and the calendar is a grid of days under its month's name.
 */
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog as AriaDialog,
  Group,
  Heading,
  I18nProvider,
  Popover as AriaPopover,
  type DateValue,
} from "react-aria-components";
import { cn } from "./cn";

export type { DateValue };
export {
  CalendarDate,
  getLocalTimeZone,
  now,
  parseAbsolute,
  parseDate,
  parseDateTime,
  toCalendarDate,
  toZoned,
  today,
  ZonedDateTime,
} from "@internationalized/date";

export type DatePickerProps = {
  value: DateValue | null;
  onChange: (value: DateValue | null) => void;
  /** `day` for a date; `minute` adds the time. */
  granularity?: "day" | "minute";
  hourCycle?: 12 | 24;
  /** Hides the time zone a date and time is shown in. */
  hideTimeZone?: boolean;
  /** What an empty field starts from, such as today in its time zone. */
  placeholderValue?: DateValue;
  /**
   * The language and order of the segments, when the field's format
   * differs from the reader's (`en-US` puts the month first).
   */
  locale?: string;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  autoFocus?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  isRequired?: boolean;
  /** `cell` covers a grid cell; `field` sits in a form. */
  variant?: "cell" | "field";
  className?: string;
};

const segmentClass =
  "rounded px-0.5 tabular-nums outline-none data-[placeholder]:text-muted-foreground data-[type=literal]:px-0 data-[type=literal]:text-muted-foreground data-[focused]:bg-primary data-[focused]:text-primary-foreground data-[focused]:data-[placeholder]:text-primary-foreground";

const navButton =
  "inline-flex h-7 w-7 items-center justify-center rounded-md outline-none hover:bg-muted data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring";

const dayClass =
  "flex h-8 w-8 cursor-default items-center justify-center rounded-md text-sm tabular-nums outline-none data-[outside-month]:hidden data-[hovered]:bg-muted data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[disabled]:opacity-40 data-[unavailable]:line-through";

export function DatePicker(props: DatePickerProps) {
  const cell = props.variant === "cell";
  const picker = (
    <AriaDatePicker
      value={props.value}
      onChange={props.onChange}
      granularity={props.granularity ?? "day"}
      hourCycle={props.hourCycle}
      hideTimeZone={props.hideTimeZone}
      placeholderValue={props.placeholderValue}
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      autoFocus={props.autoFocus}
      id={props.id}
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      aria-describedby={props["aria-describedby"]}
      isRequired={props.isRequired}
      shouldForceLeadingZeros
      // In a cell, the field grows past a narrow column to show it all.
      className={cn(cell && "h-full min-w-full w-max", props.className)}
    >
      <Group
        className={cn(
          "flex items-center gap-1 bg-card text-sm text-foreground",
          cell
            ? "h-full w-full gap-2 border-2 border-primary px-2 shadow-lg"
            : "h-9 w-full rounded-md border border-border px-2.5 data-[focus-within]:outline-2 data-[focus-within]:outline-ring",
        )}
      >
        <DateInput
          className={cn(
            "flex items-center whitespace-nowrap",
            !cell && "min-w-0 flex-1 overflow-hidden",
          )}
        >
          {(segment) => (
            <DateSegment segment={segment} className={segmentClass} />
          )}
        </DateInput>
        <AriaButton className={cn(navButton, "h-6 w-6 shrink-0")}>
          <CalendarDays className="h-4 w-4" aria-hidden />
        </AriaButton>
      </Group>
      <AriaPopover
        placement="bottom start"
        className="z-50 rounded-sm border border-border bg-card p-3 text-foreground shadow-lg outline-none"
      >
        <AriaDialog className="outline-none">
          <Calendar>
            <header className="flex items-center justify-between gap-2 pb-2">
              <AriaButton slot="previous" className={navButton}>
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </AriaButton>
              <Heading className="text-sm font-medium" />
              <AriaButton slot="next" className={navButton}>
                <ChevronRight className="h-4 w-4" aria-hidden />
              </AriaButton>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5 [&_th]:pb-1 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
              {(date) => <CalendarCell date={date} className={dayClass} />}
            </CalendarGrid>
          </Calendar>
        </AriaDialog>
      </AriaPopover>
    </AriaDatePicker>
  );
  return props.locale ? (
    <I18nProvider locale={props.locale}>{picker}</I18nProvider>
  ) : (
    picker
  );
}

/**
 * The language of every React Aria component below it: their own words
 * (a calendar button's name) and how they write dates.
 */
export function AriaLocaleProvider(props: {
  locale: string;
  children: ReactNode;
}) {
  return <I18nProvider locale={props.locale}>{props.children}</I18nProvider>;
}
