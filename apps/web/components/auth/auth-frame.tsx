import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "../../lib/i18n";
import { BrandMark } from "../brand/brand-mark";

/** A page of the register, as the product draws one: figures the person can trust. */
const ENTRIES: ReadonlyArray<{
  date: [number, number, number];
  reference: string;
  amount: number;
  signed: boolean;
}> = [
  { date: [2026, 2, 2], reference: "INV-20411", amount: 1240, signed: true },
  { date: [2026, 2, 4], reference: "INV-20412", amount: 318.5, signed: true },
  { date: [2026, 2, 9], reference: "INV-20413", amount: 12750, signed: true },
  { date: [2026, 2, 11], reference: "CRN-00318", amount: -86, signed: true },
  {
    date: [2026, 2, 16],
    reference: "INV-20414",
    amount: 2400.75,
    signed: true,
  },
  { date: [2026, 2, 17], reference: "INV-20415", amount: 540, signed: false },
];

/**
 * The sign-in pages' picture of the product: a ruled sheet with a row
 * gutter, the red margin, and figures set in tabular numerals, in the
 * person's locale. Decorative: the form beside it carries the page.
 */
function LedgerSpecimen({ className }: { className?: string }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const date = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const amount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const head = "border-b border-strong-border px-3 py-2 text-left font-medium";
  const cell = "border-b border-border px-3 py-2.5";
  return (
    <div
      aria-hidden
      className={cn(
        "overflow-hidden rounded-sm border border-border bg-card text-sm",
        className,
      )}
    >
      <table className="w-full border-collapse">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th className={cn(head, "w-10 border-r border-margin")} />
            <th className={cn(head, "border-r")}>{t`Date`}</th>
            <th className={cn(head, "border-r")}>{t`Reference`}</th>
            <th className={cn(head, "border-r text-right")}>{t`Amount`}</th>
            <th className={head}>{t`Signed`}</th>
          </tr>
        </thead>
        <tbody>
          {ENTRIES.map((entry, index) => (
            <tr key={entry.reference}>
              <td
                className={cn(
                  cell,
                  "border-r border-margin px-2 text-right text-xs text-muted-foreground",
                )}
              >
                {index + 1}
              </td>
              <td className={cn(cell, "border-r")}>
                {date.format(
                  new Date(entry.date[0], entry.date[1], entry.date[2]),
                )}
              </td>
              <td className={cn(cell, "border-r font-mono text-[13px]")}>
                {entry.reference}
              </td>
              <td className={cn(cell, "border-r text-right")}>
                {amount.format(entry.amount)}
              </td>
              <td className={cell}>
                {entry.signed ? (
                  <Check className="h-4 w-4 text-primary" strokeWidth={2.5} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The frame of the pages outside the app: sign-in, sign-up, and the reset
 * link. The form on the left, the product on the right.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="h-screen overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-12 px-6 py-10 lg:flex-row lg:items-center lg:gap-20">
        <div className="w-full max-w-sm shrink-0">
          <div className="mb-10 flex items-center gap-2">
            <BrandMark className="h-7 w-7" />
            <span className="text-lg font-semibold">AnyGridDB</span>
          </div>
          {children}
        </div>
        <LedgerSpecimen className="hidden min-w-0 flex-1 lg:block" />
      </div>
    </main>
  );
}
