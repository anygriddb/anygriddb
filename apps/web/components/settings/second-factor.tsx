import { Button, Input, Label } from "@anygriddb/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { registerPasskey } from "../../lib/webauthn";
import { useLingui } from "@lingui/react/macro";

export function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  return (
    <div className="rounded-sm border border-primary/40 bg-accent/40 p-4">
      <p className="text-sm font-medium">{t`Backup codes, shown only once.`}</p>
      <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(codes.join("\n"))}
        >
          <Copy className="h-4 w-4" aria-hidden />
          {t`Copy`}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t`I saved the codes`}
        </Button>
      </div>
    </div>
  );
}

/**
 * Enrolling a second factor: a TOTP app or a passkey, then the backup
 * codes. The account page and the first-run page share it.
 */
export function SecondFactorSetup({
  onDone,
}: {
  /** The factor is enrolled and its backup codes, if any, acknowledged. */
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: api.session.current.queryKey(),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void run(async () => {
              const result = await trpc.auth.totp.begin.mutate();
              setSecret({ secret: result.secret, url: result.otpauthUrl });
            })
          }
        >
          {t`Enable TOTP`}
        </Button>
        <Button
          variant="outline"
          disabled={!window.isSecureContext}
          onClick={() =>
            void run(async () => {
              const codes = await registerPasskey();
              toast.success(t`Passkey registered`);
              await refresh();
              if (codes.length > 0) setBackupCodes(codes);
              else onDone?.();
            })
          }
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {t`Register a passkey`}
        </Button>
      </div>
      {window.isSecureContext ? null : (
        <p className="text-sm text-muted-foreground">
          {t`Browsers accept passkeys on an HTTPS address only: use TOTP, or open AnyGridDB over HTTPS.`}
        </p>
      )}
      {secret ? (
        <form
          className="flex max-w-md flex-col gap-2"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void run(async () => {
              const result = await trpc.auth.totp.confirm.mutate({
                secret: secret.secret,
                code,
              });
              setBackupCodes(result.backupCodes);
              setSecret(null);
              setCode("");
              await refresh();
            });
          }}
        >
          <Label htmlFor="totp-secret">{t`Secret`}</Label>
          <Input
            id="totp-secret"
            readOnly
            value={secret.secret}
            className="font-mono"
          />
          <Label htmlFor="totp-url">{t`Authenticator URL`}</Label>
          <Input
            id="totp-url"
            readOnly
            value={secret.url}
            className="font-mono text-xs"
          />
          <Label htmlFor="totp-code">{t`Code`}</Label>
          <Input
            id="totp-code"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" className="self-start">
            {t`Confirm TOTP`}
          </Button>
        </form>
      ) : null}
      {backupCodes.length > 0 ? (
        <BackupCodes
          codes={backupCodes}
          onDone={() => {
            setBackupCodes([]);
            onDone?.();
          }}
        />
      ) : null}
    </div>
  );
}
