import { Button, Input, Label } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, KeyRound, Smartphone } from "lucide-react";
import { useMemo, useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { encode } from "uqr";
import { useCopy } from "../../lib/clipboard";
import { datedName, downloadText } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { registerPasskey } from "../../lib/webauthn";
import { useLingui } from "@lingui/react/macro";
import { qrPath } from "./qr-path";
import {
  backupCodesFile,
  proofNeeded,
  totpAction,
  type MfaMethod,
} from "./second-factor-model";

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
      <p className="mt-1 text-sm text-muted-foreground">
        {t`Each one signs you in once if you lose your authenticator app or your passkey. Keep them somewhere other than this device.`}
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadText(
              datedName("anygriddb-backup-codes", "txt"),
              backupCodesFile(
                codes,
                window.location.host,
                new Date().toLocaleDateString("sv-SE"),
              ),
            )
          }
        >
          <Download className="h-4 w-4" aria-hidden />
          {t`Download`}
        </Button>
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
 * The authenticator's address as a code to scan. A camera reads dark on
 * light: it stays black on white in both themes.
 */
function QrCode({ text, label }: { text: string; label: string }) {
  const modules = useMemo(
    () => encode(text, { ecc: "M", border: 3 }).data,
    [text],
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules.length} ${modules.length}`}
      shapeRendering="crispEdges"
      className="h-44 w-44 shrink-0 rounded-sm border border-border bg-white"
    >
      <path d={qrPath(modules)} className="fill-black" />
    </svg>
  );
}

/** The proof a change of second factor asks for, asked only then. */
function ProofField({
  kind,
  value,
  onChange,
}: {
  kind: "password" | "code";
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex max-w-md flex-col gap-2">
      {kind === "password" ? (
        <>
          {/* Not "Current password": the page's password form has that field. */}
          <Label htmlFor="factor-password">
            {t`Your password, to confirm a change of second factor`}
          </Label>
          <Input
            id="factor-password"
            type="password"
            autoComplete="current-password"
            required
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      ) : (
        <>
          <Label htmlFor="factor-code">{t`Current authenticator code`}</Label>
          <Input
            id="factor-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      )}
    </div>
  );
}

/**
 * Enrolling a second factor: an authenticator app or a passkey, then the
 * backup codes. The account page and the first-run page share it.
 */
export function SecondFactorSetup({
  onDone,
}: {
  /** The factor is enrolled and its backup codes, if any, acknowledged. */
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const copy = useCopy();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const instance = useQuery(api.auth.instance.queryOptions());
  const methods = (session.data?.mfaMethods ?? []) as MfaMethod[];
  const account = {
    methods,
    hasPassword: session.data?.hasPassword ?? false,
  };
  const totp = totpAction(methods);
  const passkeysOk =
    window.isSecureContext && (instance.data?.passkeysEligible ?? true);
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(
    null,
  );
  const [passkeyProof, setPasskeyProof] = useState(false);
  const [code, setCode] = useState("");
  const [proofValue, setProofValue] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const totpProof = proofNeeded("totp", account);
  const passkeyProofKind = proofNeeded("passkey", account);

  function proofOf(kind: "password" | "code" | null) {
    if (kind === "password") return { password: proofValue };
    if (kind === "code") return { factorCode: proofValue };
    return {};
  }

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

  function close() {
    setSecret(null);
    setPasskeyProof(false);
    setCode("");
    setProofValue("");
  }

  async function addPasskey() {
    const codes = await registerPasskey(proofOf(passkeyProofKind));
    toast.success(t`Passkey registered`);
    if (codes.length > 0) setBackupCodes(codes);
    close();
    await refresh();
    if (codes.length === 0) onDone?.();
  }

  if (backupCodes.length > 0) {
    return (
      <BackupCodes
        codes={backupCodes}
        onDone={() => {
          setBackupCodes([]);
          onDone?.();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {methods.length > 0 ? (
        <ul className="text-sm text-muted-foreground">
          {methods.includes("totp") ? (
            <li>{t`An authenticator app is set up.`}</li>
          ) : null}
          {methods.includes("webauthn") ? (
            <li>{t`At least one passkey is registered.`}</li>
          ) : null}
        </ul>
      ) : null}
      {secret === null && !passkeyProof ? (
        <>
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
              <Smartphone className="h-4 w-4" aria-hidden />
              {totp === "replace"
                ? t`Replace the authenticator app`
                : t`Set up an authenticator app`}
            </Button>
            <Button
              variant="outline"
              disabled={!passkeysOk}
              onClick={() => {
                if (passkeyProofKind === null) void run(addPasskey);
                else setPasskeyProof(true);
              }}
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              {methods.includes("webauthn")
                ? t`Add another passkey`
                : t`Register a passkey`}
            </Button>
          </div>
          {!window.isSecureContext ? (
            <p className="text-sm text-muted-foreground">
              {t`Browsers accept passkeys on an HTTPS address only: use an authenticator app, or open AnyGridDB over HTTPS.`}
            </p>
          ) : instance.data && !instance.data.passkeysEligible ? (
            <p className="text-sm text-muted-foreground">
              {t`Passkeys need a hostname in PUBLIC_URL (a DNS name or localhost), not an IP address. Use an authenticator app, or open AnyGridDB at that hostname.`}
            </p>
          ) : null}
        </>
      ) : null}
      {secret ? (
        <form
          className="flex max-w-2xl flex-col gap-5"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void run(async () => {
              const result = await trpc.auth.totp.confirm.mutate({
                secret: secret.secret,
                code,
                ...proofOf(totpProof),
              });
              // The codes take the panel's place before the session reads
              // again, so the buttons never show in between.
              setBackupCodes(result.backupCodes);
              close();
              await refresh();
            });
          }}
        >
          {totp === "replace" ? (
            <p className="text-sm text-muted-foreground">
              {t`Confirming replaces your current authenticator and issues new backup codes. The old app stops working.`}
            </p>
          ) : null}
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {t`Scan this code with your authenticator app.`}
            </p>
            <div className="flex flex-wrap items-start gap-6">
              <QrCode
                text={secret.url}
                label={t`Code to scan with your authenticator app`}
              />
              <div className="flex min-w-0 flex-1 basis-60 flex-col gap-2 text-sm">
                <p className="text-muted-foreground">
                  {t`No camera at hand? Type this key in the app instead.`}
                </p>
                <Label htmlFor="totp-secret">{t`Setup key`}</Label>
                <div className="flex gap-2">
                  <Input
                    id="totp-secret"
                    readOnly
                    value={secret.secret}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={t`Copy the key`}
                    onClick={() => copy(secret.secret)}
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <a
                  href={secret.url}
                  className="self-start text-primary underline-offset-2 hover:underline"
                >
                  {t`On this phone? Open it in your authenticator app.`}
                </a>
              </div>
            </div>
          </div>
          <div className="flex max-w-md flex-col gap-2">
            <Label htmlFor="totp-code">{t`Code shown by the app`}</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              className="max-w-40 font-mono"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {totpProof ? (
            <ProofField
              kind={totpProof}
              value={proofValue}
              onChange={setProofValue}
            />
          ) : null}
          <div className="flex gap-2">
            <Button type="submit">
              {totp === "replace"
                ? t`Replace and confirm`
                : t`Confirm the code`}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t`Cancel`}
            </Button>
          </div>
        </form>
      ) : null}
      {passkeyProof && passkeyProofKind ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void run(addPasskey);
          }}
        >
          <ProofField
            kind={passkeyProofKind}
            value={proofValue}
            onChange={setProofValue}
          />
          <div className="flex gap-2">
            <Button type="submit">
              <KeyRound className="h-4 w-4" aria-hidden />
              {t`Register the passkey`}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t`Cancel`}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
