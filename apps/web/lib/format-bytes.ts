import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import { useLocale } from "./i18n";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

type ByteUnit = (typeof UNITS)[number];

/**
 * A size in bytes as the number and the binary unit it reads best in:
 * bytes below 1 KiB, then one decimal of KiB, MiB, GiB, or TiB. A value
 * that would round up to 1,024 of a unit is said in the next one. What is
 * not a size reads as 0 B.
 */
export function byteSize(size: number): { value: number; unit: ByteUnit } {
  let value = Number.isFinite(size) && size > 0 ? size : 0;
  let step = 0;
  while (step < UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    step += 1;
  }
  return {
    value: step === 0 ? Math.round(value) : value,
    unit: UNITS[step] ?? "B",
  };
}

/** A size in bytes in the reader's language: "1.5 MiB", or "1,5 Mio". */
export function useFormatBytes(): (size: number) => string {
  const { t } = useLingui();
  const { locale } = useLocale();
  return useCallback(
    (bytes: number) => {
      const { value, unit } = byteSize(bytes);
      const digits = unit === "B" ? 0 : 1;
      const size = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-GB", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
      switch (unit) {
        case "B":
          return t`${{ size }} B`;
        case "KiB":
          return t`${{ size }} KiB`;
        case "MiB":
          return t`${{ size }} MiB`;
        case "GiB":
          return t`${{ size }} GiB`;
        case "TiB":
          return t`${{ size }} TiB`;
      }
    },
    [t, locale],
  );
}
