import { Button, Kbd } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { gridTipsHidden, hideGridTips } from "../../lib/grid-tips";
import { useKeyNames } from "../../lib/key-names";
import { useNarrowScreen } from "../../lib/narrow-screen";
import { openShortcuts } from "../shell/shortcuts-dialog";

/**
 * A first visit's tips over the grid: the gestures a spreadsheet's user
 * looks for first, each with its keys, until the person hides them. The
 * page stays usable while they show, so each one can be tried at once;
 * every other shortcut is one key away (?). A phone has none of these
 * keys: they do not show there.
 */
export function GridTips(props: { canEdit: boolean }) {
  const { t } = useLingui();
  const keys = useKeyNames();
  const title = useId();
  const narrow = useNarrowScreen();
  const [shown, setShown] = useState(() => !gridTipsHidden());
  if (!shown || narrow) return null;
  const tips: Array<{ id: string; keys: string[]; text: string }> = [
    {
      id: "move",
      keys: ["↑ ↓ ← →", keys.shift],
      text: t`Move between cells. With Shift, or by dragging, select several.`,
    },
    ...(props.canEdit
      ? [
          {
            id: "edit",
            keys: [keys.enter, keys.escape],
            text: t`Edit a cell, or just type in it; a double-click edits too. Esc cancels.`,
          },
          {
            id: "fill",
            keys: [keys.mod, "D"],
            text: t`Fill down, or drag the corner of the selection. Copy and paste work with any spreadsheet.`,
          },
        ]
      : [
          {
            id: "copy",
            keys: [keys.mod, "C"],
            text: t`Copy the selection, to paste it into any spreadsheet.`,
          },
        ]),
    {
      id: "open",
      keys: [keys.space],
      text: t`Open the row, with its comments and history. A right-click shows a cell's actions.`,
    },
  ];
  return (
    <section
      aria-labelledby={title}
      className="flex flex-col gap-2 border-b border-border bg-accent/40 px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={title} className="text-sm font-medium">
          {t`Getting around the grid`}
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={openShortcuts}>
            {t`All shortcuts`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              hideGridTips();
              setShown(false);
            }}
          >
            {t`Hide the tips`}
          </Button>
        </div>
      </div>
      <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {tips.map((tip) => (
          <li key={tip.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap gap-1">
              {tip.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
            <span className="text-muted-foreground">{tip.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
