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

/** The columns of the specimen: date, reference, amount, signed. */
const COLUMNS =
  "minmax(6.5rem, 8.5rem) minmax(6.5rem, 9rem) minmax(6rem, 8rem) 5rem";

/**
 * One line of the page, 32 px like its rules: a number in the margin's
 * gutter when the line is a row, then what is written after the margin.
 */
function Line({
  number,
  className,
  children,
}: {
  number?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-8">
      <span className="w-24 shrink-0 pr-4 text-right font-mono text-xs leading-8 text-muted-foreground">
        {number}
      </span>
      <div
        className={cn("mr-16 ml-0.5 grid max-w-max pl-[18px]", className)}
        style={{ gridTemplateColumns: COLUMNS }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The sign-in pages' picture of the product, written on the page itself:
 * each row sits on one of the page's rules, its number in the gutter
 * before the red margin, its figures in tabular numerals, in the person's
 * locale. Decorative: the form beside it carries the page.
 */
function LedgerSpecimen() {
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
  const cell = "truncate border-r border-rule px-3 leading-8 last:border-r-0";
  return (
    <div className="mt-16 text-[13px]">
      <Line className="box-border border-b border-strong-border bg-head font-medium text-muted-foreground">
        <span className={cell}>{t`Date`}</span>
        <span className={cell}>{t`Reference`}</span>
        <span className={cn(cell, "text-right")}>{t`Amount`}</span>
        <span className={cell}>{t`Signed`}</span>
      </Line>
      {ENTRIES.map((entry, index) => (
        <Line key={entry.reference} number={index + 1}>
          <span className={cell}>
            {date.format(new Date(entry.date[0], entry.date[1], entry.date[2]))}
          </span>
          <span className={cn(cell, "font-mono")}>{entry.reference}</span>
          <span className={cn(cell, "text-right")}>
            {amount.format(entry.amount)}
          </span>
          <span className={cell}>
            {entry.signed ? (
              <Check
                className="inline h-4 w-4 text-primary"
                strokeWidth={2.5}
              />
            ) : null}
          </span>
        </Line>
      ))}
    </div>
  );
}

/**
 * The frame of the pages outside the app: sign-in, sign-up, and the reset
 * link. The form on the left; on the right, a page of the notebook the
 * product is: ruled every 32 px, with its margin, and everything on it
 * written on its rules, whatever the width wraps.
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
            "linear-gradient(to bottom, transparent 31px, var(--color-rule) 31px)",
          backgroundSize: "100% 32px",
        }}
      >
        <div className="absolute inset-y-0 left-24 w-0.5 bg-margin" />
        <div className="absolute inset-x-0 top-32">
          <div className="pr-16 pl-32">
            <p className="max-w-[26ch] text-[28px] leading-8 font-medium tracking-tight">
              {t`Your SQL tables, read and written like a page of a notebook.`}
            </p>
            <p className="mt-8 max-w-[46ch] text-base leading-8 text-muted-foreground">
              {t`Each row is a real row of your database. Each change is signed, dated, and can be undone.`}
            </p>
          </div>
          <LedgerSpecimen />
        </div>
      </section>
    </main>
  );
}
