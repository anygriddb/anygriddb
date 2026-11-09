import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useState, type SubmitEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";

type PromptProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  children?: ReactNode;
  /** An empty value is submitted too: it clears what was there. */
  optional?: boolean;
  /** Several lines of text. */
  multiline?: boolean;
};

export function PromptDialog(props: PromptProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title}>
        {/* Mounted while open only: each opening starts from `initial`. */}
        <PromptForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function PromptForm(props: PromptProps) {
  const { t } = useLingui();
  const [value, setValue] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!value.trim() && !props.optional) return;
    setBusy(true);
    try {
      await props.onSubmit(value.trim());
      props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="prompt-value">{props.label}</Label>
      {props.multiline ? (
        <textarea
          id="prompt-value"
          autoFocus
          rows={4}
          maxLength={1_000}
          className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <Input
          id="prompt-value"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      {props.children}
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          disabled={busy || (!value.trim() && !props.optional)}
        >
          {props.submitLabel ?? t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  /** What to show between the description and the buttons. */
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title} description={props.description}>
        {props.children}
        <DialogFooter className="mt-0">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button
            variant={props.danger ? "danger" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
                props.onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
