import { Dialog, DialogContent, Kbd } from "@anygriddb/ui";
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

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
  const groups: Array<[string, Array<[string[], string]>]> = [
    [
      t`Everywhere`,
      [
        [["Ctrl", "K"], t`Find a base, a table, or an action`],
        [["?"], t`Show this help`],
      ],
    ],
    [
      t`Grid: moving`,
      [
        [["↑", "↓", "←", "→"], t`Move between cells`],
        [["Ctrl", "↑ ↓ ← →"], t`Jump to the edge of the grid`],
        [["Maj", "↑ ↓ ← →"], t`Extend the selection`],
        [["Tab"], t`Next cell (Shift: previous)`],
        [["Début", "Fin"], t`Start or end of the row (Ctrl: of the grid)`],
        [["Page ↑", "Page ↓"], t`Move up or down 15 rows`],
        [["Ctrl", "A"], t`Select all`],
      ],
    ],
    [
      t`Grid: editing`,
      [
        [["Entrée"], t`Edit the cell (or F2); typing replaces the value`],
        [["Échap"], t`Cancel editing`],
        [["Suppr"], t`Clear the selected cells`],
        [["Ctrl", "C"], t`Copy (Ctrl V pastes, even from a spreadsheet)`],
        [["Ctrl", "D"], t`Fill down`],
        [["Ctrl", "Z"], t`Undo (Ctrl Shift Z or Ctrl Y: redo)`],
        [["Espace"], t`Open the row (or Shift Enter)`],
      ],
    ],
    [t`Comments`, [[["Ctrl", "Entrée"], t`Send the comment; @ to mention`]]],
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t`Keyboard shortcuts`} wide>
        <div className="grid gap-5 overflow-y-auto sm:grid-cols-2">
          {groups.map(([title, items]) => (
            <section key={title}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
