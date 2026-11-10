import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useState, type SubmitEvent } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

export type NewTableStyle = "starter" | "blank";

/**
 * The first fields' names, in the reader's language. Declared here, not
 * written with `t` inside a helper: a macro compiles only where it is
 * called, so a `t` passed as a parameter would name every field "".
 */
const STARTER = {
  name: msg`Name`,
  notes: msg`Notes`,
  status: msg`Status`,
  todo: msg`To do`,
  doing: msg`In progress`,
  done: msg`Done`,
};

export function newTableColumns(
  say: (descriptor: MessageDescriptor) => string,
  style: NewTableStyle,
) {
  if (style === "blank") {
    return [{ label: say(STARTER.name), fieldType: "text" as const }];
  }
  return [
    { label: say(STARTER.name), fieldType: "text" as const },
    { label: say(STARTER.notes), fieldType: "long_text" as const },
    {
      label: say(STARTER.status),
      fieldType: "single_select" as const,
      config: {
        options: [
          { name: say(STARTER.todo), color: "gray" as const },
          { name: say(STARTER.doing), color: "blue" as const },
          { name: say(STARTER.done), color: "green" as const },
        ],
      },
    },
  ];
}

export function NewTableDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onCreate: (input: {
    name: string;
    columns: ReturnType<typeof newTableColumns>;
  }) => Promise<void>;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title}>
        {props.open ? <NewTableForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewTableForm(props: {
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    name: string;
    columns: ReturnType<typeof newTableColumns>;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [style, setStyle] = useState<NewTableStyle>("starter");
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onCreate({
        name: name.trim(),
        columns: newTableColumns((descriptor) => t(descriptor), style),
      });
      props.onOpenChange(false);
    } catch {
      // The caller told why; the dialog stays open to try again.
      return;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-table-name">{t`Table name`}</Label>
        <Input
          id="new-table-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">{t`Fields`}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="table-style"
            className="mt-1"
            checked={style === "starter"}
            onChange={() => setStyle("starter")}
          />
          <span>
            <span className="font-medium">{t`Starter fields`}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t`Name, Notes, and a Status list.`}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="table-style"
            className="mt-1"
            checked={style === "blank"}
            onChange={() => setStyle("blank")}
          />
          <span>
            <span className="font-medium">{t`Blank table`}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t`A single Name field.`}
            </span>
          </span>
        </label>
      </fieldset>
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          {t`Cancel`}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {t`Create`}
        </Button>
      </DialogFooter>
    </form>
  );
}
