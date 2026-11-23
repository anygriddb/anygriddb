import { Dialog, DialogContent, Kbd } from "@anygriddb/ui";
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { useKeyNames } from "../../lib/key-names";

/** Opens the shortcut help from anywhere, e.g. a menu item. */
export function openShortcuts(): void {
  window.dispatchEvent(new Event("ag:shortcuts"));
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/** Keyboard help, opened with `?` outside text fields. */
export function ShortcutsDialog() {
  const { t } = useLingui();
  const keys = useKeyNames();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !typing(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("ag:shortcuts", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ag:shortcuts", onOpen);
    };
  }, []);
  const { mod, shift, enter, escape, space, home, end } = keys;
  const groups: Array<[string, Array<[string[], string]>]> = [
    [
      t`Everywhere`,
      [
        [[mod, "K"], t`Find a base, a table, or an action`],
        [["?"], t`Show this help`],
      ],
    ],
    [
      t`Grid: moving`,
      [
        [["↑", "↓", "←", "→"], t`Move between cells`],
        [[mod, "↑ ↓ ← →"], t`Jump to the edge of the grid`],
        [[shift, "↑ ↓ ← →"], t`Extend the selection`],
        [
          ["Tab"],
          t`Next cell (${shift}: previous); at either end of the row, leaves the grid`,
        ],
        [[home, end], t`Start or end of the row (${mod}: of the grid)`],
        [["Page ↑", "Page ↓"], t`Move up or down 15 rows`],
        [[mod, "A"], t`Select all`],
      ],
    ],
    [
      t`Grid: editing`,
      [
        [[enter], t`Edit the cell (or F2); typing replaces the value`],
        [[escape], t`Cancel editing`],
        [[keys.delete], t`Clear the selected cells`],
        [[mod, "C"], t`Copy (${mod} V pastes, even from a spreadsheet)`],
        [[mod, "D"], t`Fill down`],
        [[mod, "Z"], t`Undo (${mod} ${shift} Z or ${mod} Y: redo)`],
        [[space], t`Open the row (or ${shift} ${enter})`],
      ],
    ],
    [t`Comments`, [[[mod, enter], t`Send the comment; @ to mention`]]],
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t`Keyboard shortcuts`} wide>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups.map(([title, items]) => (
            <section key={title}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {title}
              </h3>
              <ul className="flex flex-col gap-1.5 text-sm">
                {items.map(([keys, label]) => (
                  <li
                    key={label}
                    className="flex items-start justify-between gap-3"
                  >
                    <span>{label}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
