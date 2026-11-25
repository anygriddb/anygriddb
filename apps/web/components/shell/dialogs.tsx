import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useState, type SubmitEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { TRPCClientError } from "@trpc/client";
import { useErrorText } from "../../lib/errors";
import { reportFailure } from "../../lib/report-failure";

/**
 * What the server refused, kept to be said inside the dialog that asked,
 * just above its buttons. A toast in the window's corner lay over a wide
 * dialog's Save, and stayed there while the pointer went to the button.
 * Anything that is not the server's answer is told to the instance too,
 * as a page that failed.
 */
export function useRefusal() {
  const errorText = useErrorText();
  const [text, setText] = useState<string | null>(null);
  return {
    text,
    say: (cause: unknown) => {
      setText(errorText(cause));
      if (!(cause instanceof TRPCClientError)) reportFailure("error", cause);
    },
    /** A refusal written by the dialog itself. */
    show: (message: string) => setText(message),
    clear: () => setText(null),
  };
}

/** A dialog's refusal, where its reader looks: above the buttons. */
export function Refusal(props: { text: string | null; className?: string }) {
  if (!props.text) return null;
  return (
    <p role="alert" className={cn("mt-3 text-sm text-danger", props.className)}>
      {props.text}
    </p>
  );
}

/**
 * Runs a dialog's action and says whether the dialog may close.
 *
 * An action that throws is said in the dialog (`refusal`, drawn by
 * `Refusal`), and the dialog stays open to be tried again. An action
 * that answers `false` did not go through and has said why itself (a
 * name typed wrong, a proof given up): the dialog stays open too.
 * Anything else it answers closes it.
 */
export function useAction(): {
  run: (action: () => unknown) => Promise<boolean>;
  refusal: string | null;
} {
  const refusal = useRefusal();
  return {
    run: async (action) => {
      refusal.clear();
      try {
        return (await action()) !== false;
      } catch (cause) {
        refusal.say(cause);
        return false;
      }
    },
    refusal: refusal.text,
  };
}

type PromptProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial?: string;
  submitLabel?: string;
  /** Throws what it could not do; answers `false` once it said why itself. */
  onSubmit: (value: string) => unknown;
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
  const { run, refusal } = useAction();
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!value.trim() && !props.optional) return;
    setBusy(true);
    const done = await run(() => props.onSubmit(value.trim()));
    setBusy(false);
    if (done) props.onOpenChange(false);
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="prompt-value">{props.label}</Label>
      {props.multiline ? (
        <textarea
          id="prompt-value"
          autoFocus // NOSONAR: a prompt opens with the caret in its field
          rows={4}
          maxLength={1_000}
          className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <Input
          id="prompt-value"
          autoFocus // NOSONAR: a prompt opens with the caret in its field
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      {props.children}
      <Refusal text={refusal} />
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
  /** Throws what it could not do; answers `false` once it said why itself. */
  onConfirm: () => unknown;
  /** What to show between the description and the buttons. */
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const { run, refusal } = useAction();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={props.title} description={props.description}>
        {props.children}
        <Refusal text={refusal} className="mt-0 mb-3" />
        <DialogFooter className="mt-0">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button
            variant={props.danger ? "danger" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const done = await run(props.onConfirm);
              setBusy(false);
              if (done) props.onOpenChange(false);
            }}
          >
            {props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
