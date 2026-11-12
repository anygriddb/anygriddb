import { cellText, isDecimalString } from "@anygriddb/core";
import type { CatalogColumn, Collaborator } from "./types";

type Locale = "fr" | "en";

const DATE_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  iso: { year: "numeric", month: "2-digit", day: "2-digit" },
  eu: { year: "numeric", month: "2-digit", day: "2-digit" },
  us: { year: "numeric", month: "2-digit", day: "2-digit" },
  long: { year: "numeric", month: "long", day: "numeric" },
};

function localeTag(locale: Locale, format?: string): string {
  if (format === "us") return "en-US";
  if (format === "eu") return "fr-FR";
  return locale === "fr" ? "fr-FR" : "en-GB";
}

/** Intl formats a decimal string exactly, digit by digit. */
function numeric(value: number | string): number | Intl.StringNumericLiteral {
  return typeof value === "string"
    ? (value as Intl.StringNumericLiteral)
    : value;
}

/**
 * Formats a number for display. A decimal string is formatted exactly:
 * Intl reads it as written, without going through a float (ADR 0023).
 */
export function formatNumber(
  value: number | string,
  locale: Locale,
  format?: {
    precision?: number;
    style?: "decimal" | "percent" | "currency";
    currency?: string;
    thousands?: boolean;
  },
): string {
  const style = format?.style ?? "decimal";
  const options: Intl.NumberFormatOptions = {
    useGrouping: format?.thousands ?? true,
  };
  if (format?.precision !== undefined) {
    options.minimumFractionDigits = format.precision;
    options.maximumFractionDigits = format.precision;
  } else {
    options.maximumFractionDigits = 10;
  }
  if (style === "percent") {
    return `${new Intl.NumberFormat(localeTag(locale), options).format(numeric(value))} %`;
  }
  if (style === "currency") {
    try {
      return new Intl.NumberFormat(localeTag(locale), {
        ...options,
        style: "currency",
        currency: format?.currency ?? "EUR",
      }).format(numeric(value));
    } catch {
      return new Intl.NumberFormat(localeTag(locale), options).format(
        numeric(value),
      );
    }
  }
  return new Intl.NumberFormat(localeTag(locale), options).format(
    numeric(value),
  );
}

export function formatDate(
  value: string,
  locale: Locale,
  format?: { format?: string; hour12?: boolean; timeZone?: string },
  withTime = false,
): string {
  if (format?.format === "iso" && !withTime) {
    return value.slice(0, 10);
  }
  const date = withTime
    ? new Date(value)
    : new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  if (format?.format === "relative") {
    const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
    return new Intl.RelativeTimeFormat(localeTag(locale), {
      numeric: "auto",
    }).format(days, "day");
  }
  const options: Intl.DateTimeFormatOptions = {
    ...(DATE_STYLES[format?.format ?? "eu"] ?? DATE_STYLES.eu),
    timeZone: withTime ? format?.timeZone : "UTC",
  };
  if (withTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.hour12 = format?.hour12 ?? false;
  }
  return new Intl.DateTimeFormat(
    localeTag(locale, format?.format),
    options,
  ).format(date);
}

/**
 * How long ago an instant was, in the largest unit that fits: now, then
 * minutes, hours, and days ("yesterday" past a day).
 */
export function formatAgo(
  value: string,
  locale: Locale,
  now: number = Date.now(),
): string {
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(localeTag(locale), {
    numeric: "auto",
  });
  const size = Math.abs(seconds);
  if (size < 45) return format.format(0, "second");
  if (size < 3_600) return format.format(Math.round(seconds / 60), "minute");
  if (size < 86_400) return format.format(Math.round(seconds / 3_600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

export function formatDuration(seconds: number, format = "h:mm"): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor(
    (format === "d h:mm" ? total % 86_400 : total) / 3600,
  );
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  if (format === "h:mm:ss") return `${hours}:${two(minutes)}:${two(rest)}`;
  if (format === "d h:mm")
    return days > 0
      ? `${days}j ${hours}:${two(minutes)}`
      : `${hours}:${two(minutes)}`;
  return `${hours}:${two(minutes)}`;
}

export type LinkValue = { id: string; label: string };

export function isLinkArray(value: unknown): value is LinkValue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item && typeof item === "object" && "id" in item && "label" in item,
    )
  );
}

/** Plain text of a cell, as shown and as copied to the clipboard. */
export function cellDisplay(
  value: unknown,
  column: CatalogColumn,
  locale: Locale,
  people: ReadonlyMap<string, Collaborator>,
): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const config = column.config as Record<string, unknown> & {
    number?: Parameters<typeof formatNumber>[2];
    date?: Parameters<typeof formatDate>[2];
    durationFormat?: string;
  };
  const kind = column.kind;
  if (isLinkArray(value)) {
    return value.map((item) => item.label).join(", ");
  }
  if (
    column.fieldType === "user" ||
    column.fieldType === "created_by" ||
    column.fieldType === "last_modified_by"
  ) {
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map((id) => people.get(String(id))?.displayName ?? "?")
      .join(", ");
  }
  if (column.fieldType === "duration" && typeof value === "number") {
    return formatDuration(value, config.durationFormat);
  }
  // A lookup's or a rollup's durations, in their field's format.
  const asSeconds = (item: unknown) =>
    typeof item === "number"
      ? item
      : isDecimalString(item)
        ? Number(item)
        : undefined;
  if (column.duration) {
    const items = Array.isArray(value) ? value : [value];
    const seconds = items.map(asSeconds);
    if (seconds.every((item) => item !== undefined)) {
      return seconds
        .map((item) => formatDuration(item, column.duration ?? undefined))
        .join(", ");
    }
  }
  if (column.fieldType === "attachment" && Array.isArray(value)) {
    return attachmentList(value)
      .map((item) => item.filename)
      .join(", ");
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (
          typeof item === "number" ||
          (column.elem === "number" && isDecimalString(item))
        )
          return formatNumber(item, locale, config.number);
        if (typeof item === "string" && column.elem === "date")
          return formatDate(item, locale, config.date);
        return item === null ? "" : String(item);
      })
      .filter((item) => item !== "")
      .join(", ");
  }
  if (
    typeof value === "number" ||
    (kind === "number" && isDecimalString(value))
  ) {
    return formatNumber(
      value,
      locale,
      kind === "number" ? config.number : undefined,
    );
  }
  if (typeof value === "boolean") {
    return value ? "✓" : "";
  }
  if (typeof value === "string" && kind === "date") {
    return formatDate(value, locale, config.date);
  }
  if (typeof value === "string" && kind === "datetime") {
    return formatDate(value, locale, config.date, true);
  }
  return cellText(value);
}

export type AttachmentValue = {
  key: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  thumb: boolean;
};

export function attachmentList(value: unknown): AttachmentValue[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((item) => {
    if (typeof item === "string") {
      return [
        {
          key: item,
          filename: item,
          mime: "application/octet-stream",
          size: 0,
          width: null,
          height: null,
          thumb: false,
        },
      ];
    }
    if (
      item &&
      typeof item === "object" &&
      "key" in item &&
      typeof item.key === "string"
    ) {
      return [item as AttachmentValue];
    }
    return [];
  });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} o`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} Kio`;
  return `${(size / 1024 / 1024).toFixed(1)} Mio`;
}

/** Shape a value for writing: attachment objects become keys, links stay with setLinks. */
export function toWriteValue(
  fieldType: string,
  value: unknown,
): string | number | boolean | null | string[] {
  if (value === undefined || value === null) return null;
  if (fieldType === "attachment")
    return attachmentList(value).map((item) => item.key);
  if (Array.isArray(value)) return value.map(String);
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return null;
}
