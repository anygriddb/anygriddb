/**
 * Operator SMTP, OIDC, and SAML (ADR 0050). Secrets are written, never shown.
 */
import { Button, Input, Label, Spinner, Textarea } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Mail, Shield } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { useStepUp } from "./step-up";

function sourceLabel(
  t: ReturnType<typeof useLingui>["t"],
  source: "database" | "env" | "none",
): string {
  if (source === "database") return t`Configured in this page`;
  if (source === "env") return t`Using environment variables (bootstrap)`;
  return t`Not configured`;
}

export function IntegrationsTab() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t`Email and single sign-on for this instance. You can leave the environment empty at install and set these here; a complete save here overrides the environment.`}
      </p>
      <SmtpSection />
      <OidcSection />
      <SamlSection />
      <SiemSection />
    </div>
  );
}

function SmtpSection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const smtp = useQuery(api.admin.smtp.get.queryOptions());
  const [host, setHost] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [fromAddress, setFromAddress] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [clearAsk, setClearAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await Promise.all(
      [api.admin.smtp.get, api.admin.settings].map((procedure) =>
        queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
      ),
    );
  }

  if (smtp.isError) {
    return (
      <LoadFailed error={smtp.error} onRetry={() => void smtp.refetch()} />
    );
  }
  if (!smtp.data) return <Spinner />;

  const hostValue = host ?? smtp.data.host ?? "";
  const portValue = port ?? String(smtp.data.port ?? 587);
  const usernameValue = username ?? smtp.data.username ?? "";
  const fromValue = fromAddress ?? smtp.data.fromAddress ?? "";

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (!(await stepUp.ensure())) return;
      await trpc.admin.smtp.update.mutate({
        host: hostValue.trim(),
        port: Number(portValue) || 587,
        username: usernameValue.trim() || null,
        fromAddress: fromValue.trim(),
        ...(password ? { password } : {}),
      });
      setPassword("");
      setHost(null);
      setPort(null);
      setUsername(null);
      setFromAddress(null);
      await refresh();
      toast.success(t`Email settings saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <RuledSection
      title={t`Email (SMTP)`}
      description={sourceLabel(t, smtp.data.source)}
    >
      <form className="flex max-w-lg flex-col gap-3" onSubmit={save}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="smtp-host">{t`Host`}</Label>
          <Input
            id="smtp-host"
            required
            autoComplete="off"
            placeholder="smtp.example.org"
            value={hostValue}
            onChange={(event) => setHost(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="smtp-port">{t`Port`}</Label>
          <Input
            id="smtp-port"
            type="number"
            min={1}
            max={65535}
            required
            value={portValue}
            onChange={(event) => setPort(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t`465 for TLS from the start, or 587 with STARTTLS.`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="smtp-user">{t`Username`}</Label>
          <Input
            id="smtp-user"
            autoComplete="off"
            placeholder={t`Usually the full email address`}
            value={usernameValue}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="smtp-password">{t`Password`}</Label>
          <Input
            id="smtp-password"
            type="password"
            autoComplete="new-password"
            placeholder={
              smtp.data.hasPassword
                ? t`Leave blank to keep the current password`
                : undefined
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="smtp-from">{t`From address`}</Label>
          <Input
            id="smtp-from"
            required
            autoComplete="off"
            placeholder="AnyGridDB <noreply@example.org>"
            value={fromValue}
            onChange={(event) => setFromAddress(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Mail className="h-4 w-4" aria-hidden />
            {t`Save and verify`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !smtp.data.ready}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const sent = await trpc.admin.sendTestMail.mutate();
                  toast.success(t`Test email sent to ${{ to: sent.to }}`);
                } catch (cause) {
                  toast.error(errorText(cause));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {t`Send me a test email`}
          </Button>
          {smtp.data.configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setClearAsk(true)}
            >
              {t`Clear saved email`}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={clearAsk}
        onOpenChange={setClearAsk}
        title={t`Clear saved email?`}
        description={t`The instance falls back to environment variables, if any.`}
        confirmLabel={t`Clear`}
        onConfirm={() =>
          void (async () => {
            try {
              if (!(await stepUp.ensure())) return;
              await trpc.admin.smtp.clear.mutate();
              await refresh();
              toast.success(t`Saved email cleared`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          })()
        }
      />
      {stepUp.dialog}
    </RuledSection>
  );
}

function OidcSection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const oidc = useQuery(api.admin.oidc.get.queryOptions());
  const [issuer, setIssuer] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [clearAsk, setClearAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await Promise.all(
      [api.admin.oidc.get, api.admin.settings, api.session.providers].map(
        (procedure) =>
          queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
      ),
    );
  }

  if (oidc.isError) {
    return (
      <LoadFailed error={oidc.error} onRetry={() => void oidc.refetch()} />
    );
  }
  if (!oidc.data) return <Spinner />;

  const issuerValue = issuer ?? oidc.data.issuer ?? "";
  const clientIdValue = clientId ?? oidc.data.clientId ?? "";

  return (
    <RuledSection
      title={t`OpenID Connect`}
      description={sourceLabel(t, oidc.data.source)}
    >
      <form
        className="flex max-w-lg flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              if (!(await stepUp.ensure())) return;
              await trpc.admin.oidc.update.mutate({
                issuer: issuerValue.trim(),
                clientId: clientIdValue.trim(),
                ...(clientSecret ? { clientSecret } : {}),
              });
              setClientSecret("");
              setIssuer(null);
              setClientId(null);
              await refresh();
              toast.success(t`OIDC settings saved`);
            } catch (cause) {
              toast.error(errorText(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="oidc-issuer">{t`Issuer URL`}</Label>
          <Input
            id="oidc-issuer"
            required
            autoComplete="off"
            placeholder="https://login.example.org/"
            value={issuerValue}
            onChange={(event) => setIssuer(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="oidc-client-id">{t`Client ID`}</Label>
          <Input
            id="oidc-client-id"
            required
            autoComplete="off"
            value={clientIdValue}
            onChange={(event) => setClientId(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="oidc-client-secret">{t`Client secret`}</Label>
          <Input
            id="oidc-client-secret"
            type="password"
            autoComplete="new-password"
            required={!oidc.data.hasClientSecret}
            placeholder={
              oidc.data.hasClientSecret
                ? t`Leave blank to keep the current secret`
                : undefined
            }
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </div>
        {oidc.data.redirectUrl ? (
          <p className="text-xs text-muted-foreground">
            {t`Redirect URL for the identity provider:`}{" "}
            <code className="rounded bg-muted px-1">
              {oidc.data.redirectUrl}
            </code>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t`The redirect URL is derived from PUBLIC_URL after you save.`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Cable className="h-4 w-4" aria-hidden />
            {t`Save OIDC`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !issuerValue.trim()}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await trpc.admin.oidc.test.mutate({
                    issuer: issuerValue.trim(),
                  });
                  toast.success(t`OpenID discovery answered`);
                } catch (cause) {
                  toast.error(errorText(cause));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {t`Test issuer`}
          </Button>
          {oidc.data.configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setClearAsk(true)}
            >
              {t`Clear saved OIDC`}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={clearAsk}
        onOpenChange={setClearAsk}
        title={t`Clear saved OIDC?`}
        description={t`The instance falls back to environment variables, if any.`}
        confirmLabel={t`Clear`}
        onConfirm={() =>
          void (async () => {
            try {
              if (!(await stepUp.ensure())) return;
              await trpc.admin.oidc.clear.mutate();
              await refresh();
              toast.success(t`Saved OIDC cleared`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          })()
        }
      />
      {stepUp.dialog}
    </RuledSection>
  );
}

function SamlSection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const saml = useQuery(api.admin.saml.get.queryOptions());
  const [entryPoint, setEntryPoint] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<string | null>(null);
  const [idpCert, setIdpCert] = useState<string | null>(null);
  const [clearAsk, setClearAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await Promise.all(
      [api.admin.saml.get, api.admin.settings, api.session.providers].map(
        (procedure) =>
          queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
      ),
    );
  }

  if (saml.isError) {
    return (
      <LoadFailed error={saml.error} onRetry={() => void saml.refetch()} />
    );
  }
  if (!saml.data) return <Spinner />;

  const entryValue = entryPoint ?? saml.data.entryPoint ?? "";
  const issuerValue = issuer ?? saml.data.issuer ?? "";
  // The certificate saved is never sent back: the field starts empty.
  const certValue = idpCert ?? "";

  return (
    <RuledSection
      title={t`SAML`}
      description={sourceLabel(t, saml.data.source)}
    >
      <form
        className="flex max-w-lg flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              const cert = certValue.trim();
              if (!cert && !saml.data.hasIdpCert) {
                toast.error(t`Paste the identity provider certificate`);
                return;
              }
              if (!(await stepUp.ensure())) return;
              await trpc.admin.saml.update.mutate({
                entryPoint: entryValue.trim(),
                issuer: issuerValue.trim(),
                ...(cert ? { idpCert: cert } : {}),
              });
              setIdpCert(null);
              setEntryPoint(null);
              setIssuer(null);
              await refresh();
              toast.success(t`SAML settings saved`);
            } catch (cause) {
              toast.error(errorText(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="saml-entry">{t`Entry point (SSO URL)`}</Label>
          <Input
            id="saml-entry"
            required
            autoComplete="off"
            placeholder="https://idp.example.org/sso"
            value={entryValue}
            onChange={(event) => setEntryPoint(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="saml-issuer">{t`Issuer / Entity ID`}</Label>
          <Input
            id="saml-issuer"
            required
            autoComplete="off"
            value={issuerValue}
            onChange={(event) => setIssuer(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="saml-cert">{t`IdP certificate (PEM)`}</Label>
          <Textarea
            id="saml-cert"
            rows={4}
            required={!saml.data.hasIdpCert}
            placeholder={
              saml.data.hasIdpCert
                ? t`Leave blank to keep the current certificate`
                : "-----BEGIN CERTIFICATE-----"
            }
            value={certValue}
            onChange={(event) => setIdpCert(event.target.value)}
          />
        </div>
        {saml.data.callbackUrl ? (
          <p className="text-xs text-muted-foreground">
            {t`ACS URL for the identity provider:`}{" "}
            <code className="rounded bg-muted px-1">
              {saml.data.callbackUrl}
            </code>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t`The ACS URL is derived from PUBLIC_URL after you save.`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Shield className="h-4 w-4" aria-hidden />
            {t`Save SAML`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !certValue.trim()}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await trpc.admin.saml.test.mutate({
                    idpCert: certValue.trim(),
                  });
                  toast.success(t`Certificate is valid`);
                } catch (cause) {
                  toast.error(errorText(cause));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {t`Test certificate`}
          </Button>
          {saml.data.configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setClearAsk(true)}
            >
              {t`Clear saved SAML`}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={clearAsk}
        onOpenChange={setClearAsk}
        title={t`Clear saved SAML?`}
        description={t`The instance falls back to environment variables, if any.`}
        confirmLabel={t`Clear`}
        onConfirm={() =>
          void (async () => {
            try {
              if (!(await stepUp.ensure())) return;
              await trpc.admin.saml.clear.mutate();
              await refresh();
              toast.success(t`Saved SAML cleared`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          })()
        }
      />
      {stepUp.dialog}
    </RuledSection>
  );
}

function SiemSection() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const siem = useQuery(api.admin.siem.get.queryOptions());
  const [url, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [clearAsk, setClearAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: api.admin.siem.get.queryKey(),
    });
  }

  if (siem.isError) {
    return (
      <LoadFailed error={siem.error} onRetry={() => void siem.refetch()} />
    );
  }
  if (!siem.data) return <Spinner />;

  const urlValue = url ?? siem.data.url ?? "";

  return (
    <RuledSection
      title={t`SIEM webhook`}
      description={t`Optional HTTPS endpoint that receives selected sign-in and administration events. The body never includes an email, password, or token.`}
    >
      <form
        className="flex max-w-lg flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            setBusy(true);
            try {
              await trpc.admin.siem.update.mutate({
                url: urlValue.trim(),
                ...(secret ? { secret } : {}),
              });
              setSecret("");
              setUrl(null);
              await refresh();
              toast.success(t`SIEM webhook saved`);
            } catch (cause) {
              toast.error(errorText(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="siem-url">{t`HTTPS URL`}</Label>
          <Input
            id="siem-url"
            required
            autoComplete="off"
            placeholder="https://siem.example.org/hooks/anygriddb"
            value={urlValue}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="siem-secret">{t`HMAC secret`}</Label>
          <Input
            id="siem-secret"
            type="password"
            autoComplete="new-password"
            required={!siem.data.hasSecret}
            minLength={16}
            placeholder={
              siem.data.hasSecret
                ? t`Leave blank to keep the current secret`
                : undefined
            }
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Cable className="h-4 w-4" aria-hidden />
            {t`Save SIEM webhook`}
          </Button>
          {siem.data.configured ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await trpc.admin.siem.test.mutate();
                      toast.success(t`Test event sent`);
                    } catch (cause) {
                      toast.error(errorText(cause));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t`Send test event`}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setClearAsk(true)}
              >
                {t`Clear SIEM webhook`}
              </Button>
            </>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={clearAsk}
        onOpenChange={setClearAsk}
        title={t`Clear SIEM webhook?`}
        description={t`No further auth events are posted until you configure it again.`}
        confirmLabel={t`Clear`}
        onConfirm={() =>
          void (async () => {
            try {
              await trpc.admin.siem.clear.mutate();
              await refresh();
              toast.success(t`SIEM webhook cleared`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          })()
        }
      />
    </RuledSection>
  );
}
