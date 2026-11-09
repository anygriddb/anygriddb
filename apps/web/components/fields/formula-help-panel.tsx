/**
 * The formula editor's function palette: the functions by group, a search
 * over their names and what they do, and the selected one's arguments,
 * sentence, and example. Hovering or focusing a function shows its help;
 * choosing it writes `NAME()` with the cursor between the parentheses.
 */
import type { FormulaFn } from "@anygriddb/core";
import { cn, Input } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import {
  FORMULA_DOCS,
  FORMULA_GROUP_LABELS,
  formulaGroups,
} from "./formula-docs";

const GROUPS = formulaGroups();

/** Folds case and accents, so "decoupe" finds "Découpe". */
function folded(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function FormulaHelpPanel(props: {
  onInsert: (text: string, options?: { back?: number }) => void;
}) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FormulaFn | null>(null);
  const shown = useMemo(() => {
    const wanted = folded(query.trim());
    if (!wanted) return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      fns: group.fns.filter(
        (fn) =>
          folded(fn).includes(wanted.replace(/\s+/g, "_")) ||
          folded(i18n._(FORMULA_DOCS[fn].summary)).includes(wanted),
      ),
    })).filter((group) => group.fns.length > 0);
  }, [query, i18n]);
  const doc = selected ? FORMULA_DOCS[selected] : null;

  return (
    <div className="flex max-h-80 flex-col rounded-md border border-border text-xs">
      <div className="border-b border-border p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search functions`}
          aria-label={t`Search functions`}
          className="h-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="text-muted-foreground">{t`No function`}</p>
        ) : null}
        {shown.map((group) => (
          <div key={group.group} className="mb-2">
            <p className="font-medium text-muted-foreground">
              {t(FORMULA_GROUP_LABELS[group.group])}
            </p>
            <div className="flex flex-wrap gap-1 pt-1">
              {group.fns.map((fn) => (
                <button
                  key={fn}
                  type="button"
                  aria-describedby={
                    selected === fn ? "formula-fn-help" : undefined
                  }
                  className={cn(
                    "rounded bg-muted px-1 font-mono hover:bg-accent",
                    selected === fn && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setSelected(fn)}
                  onFocus={() => setSelected(fn)}
                  onClick={() => {
                    setSelected(fn);
                    props.onInsert(`${fn.toUpperCase()}()`, { back: 1 });
                  }}
                >
                  {fn.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div
        id="formula-fn-help"
        data-testid="formula-fn-help"
        aria-live="polite"
        className="min-h-16 border-t border-border bg-muted/40 p-2"
      >
        {doc && selected ? (
          <>
            <p className="font-mono font-medium">
              {selected.toUpperCase()}
              {t(doc.args)}
            </p>
            <p className="pt-0.5">{t(doc.summary)}</p>
            <p className="pt-0.5 text-muted-foreground">
              {t`Example:`}{" "}
              <span className="font-mono break-all">{doc.example}</span>
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            {t`Hover over a function to see what it does.`}
          </p>
        )}
      </div>
    </div>
  );
}
