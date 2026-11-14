import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { setProofAsker } from "../../lib/proof";
import { trpc } from "../../lib/trpc";
import { stepUpFields, type StepUpNeed } from "./step-up-model";

/**
 * Ensures the session's Administration step-up is fresh (five minutes).
 * Opens a dialog for the password or authenticator when it is not.
 */
export function useStepUp() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [pending, setPending] = useState<{
    needs: StepUpNeed;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const ensure = useCallback(async (): Promise<boolean> => {
    const status = await trpc.admin.stepUpStatus.query();
    if (status.fresh) return true;
    if (status.needs === "sign_in") {
      toast.error(
        t`Sign out, sign in again, and do this within five minutes: your sign-in is the proof it asks for.`,
      );
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      setPassword("");
      setCode("");
      setPending({ needs: status.needs, resolve });
    });
  }, [t]);

  async function submit(): Promise<void> {
    if (!pending) return;
    const fields = stepUpFields(pending.needs);
    setBusy(true);
    try {
      await trpc.admin.stepUp.mutate({
        ...(fields.password && password ? { password } : {}),
        ...(fields.code && code ? { factorCode: code } : {}),
      });
      pending.resolve(true);
      setPending(null);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function cancel(): void {
    pending?.resolve(false);
    setPending(null);
  }

  const fields = pending ? stepUpFields(pending.needs) : null;
  const dialog: ReactNode =
    pending && fields ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogContent
          title={t`Confirm it is you`}
          description={t`A change made in Administration asks for your password or second factor again. The proof stays valid for five minutes.`}
        >
          <div className="flex flex-col gap-2">
            {fields.password ? (
              <>
                <Label htmlFor="step-up-password">{t`Password`}</Label>
                <Input
                  id="step-up-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </>
            ) : null}
            {fields.code ? (
              <>
                <Label htmlFor="step-up-code">
                  {t`Authenticator or backup code`}
                </Label>
                <Input
                  id="step-up-code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              {t`Cancel`}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={
                busy ||
                (fields.password && !password && !code) ||
                (!fields.password && fields.code && !code)
              }
            >
              {t`Confirm`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null;

  return { ensure, dialog };
}

/**
 * Asks for the proof whenever the server refuses a change for want of it
 * (`lib/proof.ts`), for every page of Administration: mounted once, in
 * its shell.
 */
export function ProofGate() {
  const { ensure, dialog } = useStepUp();
  useEffect(() => {
    setProofAsker(ensure);
    return () => setProofAsker(null);
  }, [ensure]);
  return dialog;
}
