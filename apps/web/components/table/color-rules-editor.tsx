import {
  OPTION_COLORS,
  type FilterGroup,
  type OptionColor,
} from "@anygriddb/core";
import { Button, Dialog, DialogContent, DialogFooter } from "@anygriddb/ui";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { OptionColorSwatches } from "../fields/option-color";
import { FilterBuilder, newCondition } from "./filter-builder";

type ColorRule = { filter: FilterGroup; color: OptionColor };

export function ColorRulesEditor(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
  rules: readonly ColorRule[];
  onSave: (rules: ColorRule[]) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<ColorRule[]>(() => [...props.rules]);
  const first = props.columns[0];

  function open(next: boolean) {
    if (next) setDraft([...props.rules]);
    props.onOpenChange(next);
  }

  return (
    <Dialog open={props.open} onOpenChange={open}>
      <DialogContent title={t`Colour rules`} wide>
        <p className="mb-3 text-sm text-muted-foreground">
          {t`The first matching rule colours the row.`}
        </p>
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {draft.map((rule, index) => (
            <li key={index} className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <OptionColorSwatches
                  label={t`Colour of rule ${{ number: index + 1 }}`}
                  value={rule.color}
                  onChange={(color) =>
                    setDraft((current) =>
                      current.map((item, at) =>
                        at === index ? { ...item, color } : item,
                      ),
                    )
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Delete rule`}
                  onClick={() =>
                    setDraft((current) =>
                      current.filter((_, at) => at !== index),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <FilterBuilder
                group={rule.filter}
                columns={props.columns}
                people={props.people}
                onChange={(filter) =>
                  setDraft((current) =>
                    current.map((item, at) =>
                      at === index ? { ...item, filter } : item,
                    ),
                  )
                }
              />
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={!first || draft.length >= 20}
          onClick={() =>
            first &&
            setDraft((current) => [
              ...current,
              {
                color:
                  OPTION_COLORS[current.length % OPTION_COLORS.length] ??
                  "gray",
                filter: {
                  conjunction: "and",
                  conditions: [newCondition(first)],
                },
              },
            ])
          }
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add a colour rule`}
        </Button>
        <DialogFooter>
          <Button variant="ghost" onClick={() => open(false)}>
            {t`Cancel`}
          </Button>
          <Button
            onClick={() => {
              props.onSave(draft);
              props.onOpenChange(false);
            }}
          >
            {t`Save`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
