import { Button, Label, Select, Spinner } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { datedName, downloadCsv } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";

const ACTIONS = [
  "account_created",
  "login_success",
  "login_failure",
  "logout",
  "session_revoked",
  "factors_cleared",
  "tokens_revoked",
  "account_locked",
  "account_unlocked",
  "password_changed",
  "password_reset_requested",
  "password_reset",
  "settings_changed",
  "account_disabled",
  "account_erased",
  "account_updated",
  "sso_unlinked",
  "operator_mail_sent",
] as const;
type AuthAction = (typeof ACTIONS)[number];

function date(value: string): string {
  return new Date(value).toLocaleString();
}

/** The sign-in trail (ADR 0042): sign-ins, failures, and admin actions. */
export function SignInTrail() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const session = useSession();
  const isAdmin = session.data?.isAdmin === true;
  const api = useTRPC();
  const [action, setAction] = useState<AuthAction | "">("");
  const [cursors, setCursors] = useState<string[]>([]);
  const trail = useQuery(
    api.admin.authAudit.queryOptions({
      action: action || undefined,
      before: cursors.at(-1),
      limit: 50,
    }),
  );
  const actionLabel = (value: AuthAction) =>
    ({
      account_created: t`Account created`,
      login_success: t`Signed in`,
      login_failure: t`Sign-in refused`,
      logout: t`Signed out`,
      session_revoked: t`Session ended`,
      factors_cleared: t`Second factors removed`,
      tokens_revoked: t`API tokens revoked`,
      account_locked: t`Account locked`,
      account_unlocked: t`Account unlocked`,
      password_changed: t`Password changed`,
      password_reset_requested: t`Reset link sent`,
      password_reset: t`Password reset`,
      settings_changed: t`Setting changed`,
      account_disabled: t`Account disabled`,
      account_erased: t`Account erased`,
      account_updated: t`Account changed`,
      sso_unlinked: t`Single sign-on unlinked`,
      operator_mail_sent: t`Notice emailed`,
    })[value];
  const methodLabel = (value: string | null) =>
    value
      ? ((
          {
            password: t`Password`,
            totp: t`Authenticator code`,
            backup: t`Backup code`,
            webauthn: t`Passkey`,
            oidc: "OIDC",
            saml: "SAML",
            signup: t`Sign-up`,
            admin: t`Administrator`,
          } as Record<string, string>
        )[value] ?? value)
      : "—";
  const detailLabel = (value: string | null) =>
    value
      ? ((
          {
            invalid_credentials: t`Wrong email or password`,
            account_disabled: t`Account disabled`,
            instance_maintenance: t`Maintenance`,
            mfa_failed: t`Wrong second factor`,
            admin_disable: t`Account disabled`,
            admin_erase: t`By an administrator`,
            // What an administrator corrected (account_updated).
            display_name: t`Display name`,
            email: t`Email`,
            all_active: t`Every active account`,
            selected: t`Chosen accounts`,
            as_admin: t`As an administrator`,
            admin_revoke_session: t`One session`,
            admin_revoke_user: t`All their sessions`,
            admin_revoke_all: t`Everyone else`,
            maintenance: t`Maintenance`,
            account_locked: t`Account locked`,
            admin_unlock: t`By an administrator`,
            self_service: t`Asked by the person`,
            admin_reset: t`Link from an administrator`,
            reset_link: t`By an administrator`,
            // Settings that changed (settings_changed).
            signup: t`Sign-ups`,
            defaultLocale: t`Default language`,
            banner: t`Announcement`,
            mfaScope: t`Who needs a second factor`,
            ssoMfa: t`Second factor after single sign-on`,
            lockoutThreshold: t`Failed attempts before locking`,
            lockoutMinutes: t`Lock duration`,
            sessionIdleMinutes: t`Session idle timeout`,
            sessionMaxHours: t`Session lifetime`,
            passwordMinLength: t`Password length`,
            passwordReset: t`Password resets`,
            tokenMaxDays: t`API token lifetime`,
            publicLinks: t`Public links`,
            signupDomains: t`Sign-up domains`,
            authRetentionDays: t`Sign-in trail retention`,
            invitations: t`Whom owners can invite`,
            baseCreation: t`Who can create bases`,
            apiTokens: t`Who can create API tokens`,
            inactiveDays: t`Disable accounts nobody uses`,
            lockAlerts: t`Tell administrators`,
            inactive: t`After a time without activity`,
            smtp: t`Email (SMTP)`,
            oidc: t`OpenID Connect`,
            saml: t`SAML`,
            siem: t`SIEM webhook`,
          } as Record<string, string>
        )[value] ?? value)
      : "";
  async function exportCsv() {
    try {
      const file = await trpc.admin.exportAuthAudit.mutate({
        action: action || undefined,
      });
      downloadCsv(datedName("anygriddb-sign-ins", "csv"), file.csv);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="sign-in-action">{t`Event`}</Label>
          <Select
            id="sign-in-action"
            className="w-52"
            value={action}
            onChange={(event) => {
              setAction(event.target.value as AuthAction | "");
              setCursors([]);
            }}
          >
            <option value="">{t`All`}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        {isAdmin ? (
          <Button size="sm" variant="outline" onClick={() => void exportCsv()}>
            <Download className="h-4 w-4" aria-hidden />
            {t`Export as CSV`}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {trail.data
          ? t`Events are kept ${{ days: trail.data.retentionDays }} days, then deleted. ${{ total: trail.data.total }} events kept now. An email, a password, or a token is never stored.`
          : null}
      </p>
      {trail.isLoading ? <Spinner /> : null}
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-2 py-1.5">{t`Date`}</th>
              <th className="px-2 py-1.5">{t`Event`}</th>
              <th className="px-2 py-1.5">{t`Account`}</th>
              <th className="px-2 py-1.5">{t`How`}</th>
              <th className="px-2 py-1.5">{t`By`}</th>
              <th className="px-2 py-1.5">{t`Address`}</th>
            </tr>
          </thead>
          <tbody>
            {(trail.data?.events ?? []).map((event) => (
              <tr key={event.id} className="border-t border-border">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {date(event.occurredAt)}
                </td>
                <td className="px-2 py-1.5">
                  <span
                    className={
                      event.action === "login_failure"
                        ? "font-medium text-danger"
                        : undefined
                    }
                  >
                    {actionLabel(event.action)}
                  </span>
                  {event.detail ? (
                    <span className="block text-muted-foreground">
                      {detailLabel(event.detail)}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">{event.userName ?? "—"}</td>
                <td className="px-2 py-1.5">{methodLabel(event.method)}</td>
                <td className="px-2 py-1.5">{event.actorName ?? "—"}</td>
                <td className="px-2 py-1.5 font-mono">{event.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={cursors.length === 0}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {t`Newer`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!trail.data?.next}
          onClick={() => {
            const next = trail.data?.next;
            if (next) setCursors((current) => [...current, next]);
          }}
        >
          {t`Older`}
        </Button>
      </div>
    </div>
  );
}
