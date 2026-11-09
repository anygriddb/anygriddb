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
  const head =
    "border-b border-strong-border px-3 py-1.5 text-left text-[13px] font-medium";
  const cell = "border-b border-rule px-3 py-1.5";
  return (
    <div
      aria-hidden
      className={cn(
        "overflow-hidden rounded-sm border border-rule bg-card text-[13px] leading-5",
        className,
      )}
    >
      <table className="w-full border-collapse">
        <thead className="bg-head text-muted-foreground">
          <tr>
            <th className={cn(head, "w-10 border-r-2 border-margin")} />
            <th className={cn(head, "border-r border-r-rule")}>{t`Date`}</th>
            <th className={cn(head, "border-r border-r-rule")}>
              {t`Reference`}
            </th>
            <th className={cn(head, "border-r border-r-rule text-right")}>
              {t`Amount`}
            </th>
            <th className={head}>{t`Signed`}</th>
          </tr>
        </thead>
        <tbody>
          {ENTRIES.map((entry, index) => (
            <tr key={entry.reference}>
              <td
                className={cn(
                  cell,
                  "border-r-2 border-margin bg-head px-2 text-right font-mono text-xs text-muted-foreground",
                )}
              >
                {index + 1}
              </td>
              <td className={cn(cell, "border-r border-r-rule")}>
                {date.format(
                  new Date(entry.date[0], entry.date[1], entry.date[2]),
                )}
              </td>
              <td className={cn(cell, "border-r border-r-rule font-mono")}>
                {entry.reference}
              </td>
              <td className={cn(cell, "border-r border-r-rule text-right")}>
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
 * link. The form on the left; on the right, a page of the notebook the
 * product is: ruled, with its margin, and a sheet of figures on it.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <main className="flex h-screen overflow-hidden">
      <section className="flex w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-background px-8 py-10 lg:w-[34rem] lg:px-16">
        <div className="flex items-center gap-2">
          <BrandMark className="h-6 w-6" />
          <span className="text-base font-semibold">AnyGridDB</span>
        </div>
        <div className="my-auto w-full max-w-sm py-10">{children}</div>
      </section>
      <section
        aria-hidden
        className="relative hidden min-w-0 flex-1 overflow-hidden bg-card lg:block"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, var(--color-rule) 1px, transparent 1px)",
          backgroundSize: "100% 32px",
          backgroundPosition: "0 15px",
        }}
      >
        <div className="absolute inset-y-0 left-24 w-0.5 bg-margin" />
        <div className="absolute top-[143px] right-16 left-32">
          <p className="max-w-[22ch] text-[28px] leading-8 font-medium tracking-tight">
            {t`Your SQL tables, read and written like a page of a notebook.`}
          </p>
          <p className="mt-8 max-w-[46ch] text-base leading-8 text-muted-foreground">
            {t`Each row is a real row of your database. Each change is signed, dated, and can be undone.`}
          </p>
        </div>
        <LedgerSpecimen className="absolute top-[399px] right-16 left-32" />
      </section>
    </main>
  );
}
