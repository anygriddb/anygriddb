import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useId, useState, type SubmitEvent } from "react";
import { wholeNumberIn } from "./whole-number";

/**
 * Asks for a whole number within bounds: what a drag of the pointer sets,
 * for a person on the keyboard. A number out of bounds is refused, and said.
 */
export function NumberPrompt(props: {
  title: string;
  label: string;
  initial: number;
  min: number;
  max: number;
  onSubmit: (value: number) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent title={props.title}>
        <NumberForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function NumberForm(props: {
  label: string;
  initial: number;
  min: number;
  max: number;
  onSubmit: (value: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [text, setText] = useState(String(props.initial));
  const [refused, setRefused] = useState(false);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const value = wholeNumberIn(text, props.min, props.max);
    if (value === null) {
      setRefused(true);
      return;
    }
    props.onSubmit(value);
    props.onClose();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-value`}>{props.label}</Label>
        <Input
          id={`${id}-value`}
          autoFocus
          inputMode="numeric"
          value={text}
          aria-invalid={refused}
          aria-describedby={`${id}-bounds`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setText(event.target.value);
            setRefused(false);
          }}
        />
        {/* Drawn anew when refused: an alert is read as it appears. */}
        <p
          key={refused ? "refused" : "bounds"}
          id={`${id}-bounds`}
          role={refused ? "alert" : undefined}
          className={
            refused ? "text-xs text-danger" : "text-xs text-muted-foreground"
          }
        >
          {t`A whole number from ${{ min: props.min }} to ${{ max: props.max }}.`}
        </p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onClose}>
          {t`Cancel`}
        </Button>
        <Button type="submit">{t`Apply`}</Button>
      </DialogFooter>
    </form>
  );
}
