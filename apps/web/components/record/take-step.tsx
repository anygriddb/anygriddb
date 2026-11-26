import type { StatusCircuit, StatusTransition } from "@anygriddb/core";
import { stateByKey } from "@anygriddb/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useState, type ReactNode, type SubmitEvent } from "react";
import { toast } from "sonner";
import { reasonOf, useErrorText } from "../../lib/errors";
import { trpc } from "../../lib/trpc";
import type { RowItem } from "../../lib/types";
import { PromptDialog, Refusal, useRefusal } from "../shell/dialogs";
import { useTable } from "../table/table-context";
import { circuitWord } from "./circuit-labels";

/** A step to take: of which row, along which circuit, which one. */
type Step = {
  row: RowItem;
  circuit: StatusCircuit;
  transition: StatusTransition;
};

/** A step that makes a sealed row writable again is confirmed first. */
function reopens(step: Step): boolean {
  const from =
    typeof step.row.ag_status === "string"
      ? stateByKey(step.circuit, step.row.ag_status)
      : undefined;
  const to = stateByKey(step.circuit, step.transition.toStateKey);
  return (
    step.transition.key === "unlock" ||
    (from?.seal === true && to?.rowWritable === true)
  );
}

/**
 * Takes a step of a row's circuit with what the step asks (ADR 0124,
 * 0130): a reason, a signature, a confirmation when it makes a sealed row
 * writable again. `take` starts it, from the row's panel or a kanban's
 * drop; `dialogs` draws what it asks, where the caller puts it.
 */
export function useTakeStep(): {
  take: (
    row: RowItem,
    circuit: StatusCircuit,
    transition: StatusTransition,
  ) => void;
  busy: boolean;
  dialogs: ReactNode;
} {
  const { t, i18n } = useLingui();
  const table = useTable();
  const errorText = useErrorText();
  const [step, setStep] = useState<Step | null>(null);
  const [asking, setAsking] = useState<"reason" | "sign" | "confirm" | null>(
    null,
  );
  const [pendingReason, setPendingReason] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function run(current: Step, input: Signed = {}): Promise<void> {
    setBusy(true);
    const sent = {
      tableId: table.table.id,
      rowId: current.row.id,
      transitionKey: current.transition.key,
      reason: input.reason ?? pendingReason,
      meaning: input.meaning,
      password: input.password,
      factorCode: input.factorCode,
    };
    try {
      await trpc.rows.transition.mutate(sent);
      setPendingReason(undefined);
    } catch (error: unknown) {
      toast.error(errorText(error));
      setBusy(false);
      throw error;
    }
    setBusy(false);
  }

  function take(
    row: RowItem,
    circuit: StatusCircuit,
    transition: StatusTransition,
  ) {
    const next = { row, circuit, transition };
    setStep(next);
    // A signed step asks its reason, when it needs one, with the proof.
    if (transition.signature !== "none") {
      setAsking("sign");
      return;
    }
    if (transition.requireReason) {
      setAsking("reason");
      return;
    }
    if (reopens(next)) {
      setAsking("confirm");
      return;
    }
    // Refused, it is said by a toast: nothing more to do here.
    run(next).catch(() => undefined);
  }

  const label = step ? circuitWord(i18n, "transition", step.transition) : "";
  const dialogs = step ? (
    <>
      {asking === "reason" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setAsking(null)}
          title={label}
          label={t`This transition needs a reason, kept in the audit trail.`}
          submitLabel={t`Confirm`}
          onSubmit={(reason) => {
            if (!reason.trim()) return false;
            if (reopens(step)) {
              setPendingReason(reason);
              setAsking("confirm");
              return true;
            }
            setAsking(null);
            run(step, { reason }).catch(() => undefined);
            return true;
          }}
        />
      ) : null}
      <SignDialog
        open={asking === "sign"}
        onOpenChange={(open) => setAsking(open ? "sign" : null)}
        transition={step.transition}
        onConfirm={async (signed) => {
          await run(step, signed);
          setAsking(null);
        }}
      />
      <UnlockDialog
        open={asking === "confirm"}
        onOpenChange={(open) => setAsking(open ? "confirm" : null)}
        hadSignature={step.row.ag_status === "signed"}
        transitionLabel={label}
        onConfirm={() => run(step)}
      />
    </>
  ) : null;
  return { take, busy, dialogs };
}

function UnlockDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hadSignature: boolean;
  transitionLabel: string;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        title={props.transitionLabel}
        description={
          props.hadSignature
            ? t`The row goes back to a writable state and can be changed again. Its signature stays in the history.`
            : t`The row goes back to a writable state and can be changed again.`
        }
      >
        <DialogFooter className="mt-0">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button
            onClick={async () => {
              await props.onConfirm();
              props.onOpenChange(false);
            }}
          >
            {props.transitionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a signed step sends: its meaning, its proof, and its reason. */
type Signed = {
  reason?: string;
  meaning?: string;
  password?: string;
  factorCode?: string;
};

function SignDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transition: StatusTransition;
  onConfirm: (signed: Signed) => Promise<void>;
}) {
  const { t, i18n } = useLingui();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        title={circuitWord(i18n, "transition", props.transition)}
        description={
          props.transition.signature === "step_up"
            ? t`Your signature commits you: enter your password again, or a code of your authenticator.`
            : t`Your signature commits you: enter your password again.`
        }
      >
        {props.open ? (
          <SignForm
            transition={props.transition}
            onOpenChange={props.onOpenChange}
            onConfirm={props.onConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SignForm(props: {
  transition: StatusTransition;
  onOpenChange: (open: boolean) => void;
  onConfirm: (signed: Signed) => Promise<void>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [meaning, setMeaning] = useState("");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const refusal = useRefusal();
  const byCode = props.transition.signature === "step_up";
  const asksReason = props.transition.requireReason;
  const proved = password.length >= 12 || (byCode && code.trim().length >= 6);
  const ready =
    meaning.trim() !== "" && proved && (!asksReason || reason.trim() !== "");
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready) return;
    refusal.clear();
    setBusy(true);
    const signed: Signed = {
      meaning: meaning.trim(),
      ...(asksReason ? { reason: reason.trim() } : {}),
      ...(password.length >= 12 ? { password } : { factorCode: code.trim() }),
    };
    try {
      await props.onConfirm(signed);
      props.onOpenChange(false);
    } catch (error: unknown) {
      // A wrong password is tried again here; anything else ends the dialog.
      if (reasonOf(error).code === "invalid_credentials") {
        refusal.say(error);
      } else {
        toast.error(errorText(error));
        props.onOpenChange(false);
      }
    }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="sign-meaning">{t`Meaning`}</Label>
      <Input
        id="sign-meaning"
        autoFocus
        placeholder={t`For example: Approved, Verified, Reviewed`}
        value={meaning}
        maxLength={500}
        onChange={(event) => setMeaning(event.target.value)}
      />
      {asksReason ? (
        <>
          <Label htmlFor="sign-reason">{t`Reason`}</Label>
          <Input
            id="sign-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      ) : null}
      <Label htmlFor="sign-password">{t`Password`}</Label>
      <Input
        id="sign-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {byCode ? (
        <>
          <Label htmlFor="sign-code">{t`Or a code of your authenticator`}</Label>
          <Input
            id="sign-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            maxLength={64}
            onChange={(event) => setCode(event.target.value)}
          />
        </>
      ) : null}
      <Refusal text={refusal.text} />
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          {t`Cancel`}
        </Button>
        <Button type="submit" disabled={busy || !ready}>
          {t`Sign`}
        </Button>
      </DialogFooter>
    </form>
  );
}
