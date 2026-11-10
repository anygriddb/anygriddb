import { Button, Input, Label } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { registerPasskey } from "../../lib/webauthn";
import { useLingui } from "@lingui/react/macro";
import { totpAction, type MfaMethod } from "./second-factor-model";

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
  const session = useSession();
  const instance = useQuery(api.auth.instance.queryOptions());
  const methods = (session.data?.mfaMethods ?? []) as MfaMethod[];
  const totp = totpAction(methods);
  const passkeysOk =
    window.isSecureContext && (instance.data?.passkeysEligible ?? true);
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
      {methods.length > 0 ? (
        <ul className="text-sm text-muted-foreground">
          {methods.includes("totp") ? (
            <li>{t`Authenticator app (TOTP) is set up.`}</li>
          ) : null}
          {methods.includes("webauthn") ? (
            <li>{t`At least one passkey is registered.`}</li>
          ) : null}
        </ul>
      ) : null}
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
          {totp === "replace" ? t`Replace TOTP` : t`Enable TOTP`}
        </Button>
        <Button
          variant="outline"
          disabled={!passkeysOk}
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
          {methods.includes("webauthn")
            ? t`Add another passkey`
            : t`Register a passkey`}
        </Button>
      </div>
      {!window.isSecureContext ? (
        <p className="text-sm text-muted-foreground">
          {t`Browsers accept passkeys on an HTTPS address only: use TOTP, or open AnyGridDB over HTTPS.`}
        </p>
      ) : instance.data && !instance.data.passkeysEligible ? (
        <p className="text-sm text-muted-foreground">
          {t`Passkeys need a hostname in PUBLIC_URL (a DNS name or localhost), not an IP address. Use a TOTP app, or open AnyGridDB at that hostname.`}
        </p>
      ) : null}
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
          {totp === "replace" ? (
            <p className="text-sm text-muted-foreground">
              {t`Confirming replaces your current authenticator and issues new backup codes. The old app stops working.`}
            </p>
          ) : null}
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
            {totp === "replace" ? t`Replace and confirm` : t`Confirm TOTP`}
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
