import { Button, Label, Select, Spinner } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { datedName, downloadCsv } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useWhen } from "../../lib/i18n";
import { SortHeader } from "../sort-header";
import { AdminPageSizeSelect, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPageSize } from "./admin-page-size";
import { useAuthLabels } from "./auth-labels";
import { useReadsAll } from "./admin-access";
import { InstantRange } from "./instant-range";
import {
  SIGN_IN_ACTIONS,
  nextSignIns,
  toggleSignInDir,
  trailRangeInvalid,
  type SignInSearch,
} from "./trail-search";

type AuthAction = (typeof SIGN_IN_ACTIONS)[number];

/** The sign-in trail (ADR 0042): sign-ins, failures, and admin actions. */
export function SignInTrail({
  search,
  onSearch,
}: {
  search: SignInSearch;
  onSearch: (update: (current: SignInSearch) => SignInSearch) => void;
}) {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  // An auditor exports too: the export is on the trail under their name.
  const readsAll = useReadsAll();
  const api = useTRPC();
  const invalid = trailRangeInvalid(search);
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageSize, setPageSize] = useAdminPageSize();
  const serial = JSON.stringify(search);
  const [seen, setSeen] = useState(serial);
  if (serial !== seen) {
    setSeen(serial);
    setCursors([]);
  }
  const oldestFirst = (search.dir ?? "desc") === "asc";
  const trail = useQuery({
    ...api.admin.authAudit.queryOptions({
      action: search.action,
      from: search.from,
      to: search.to,
      direction: search.dir ?? "desc",
      before: cursors.at(-1),
      limit: pageSize,
    }),
    enabled: !invalid,
    placeholderData: invalid ? undefined : (previous) => previous,
  });
  const labels = useAuthLabels();
  const actionLabel = (value: AuthAction) => labels.action(value);
  const methodLabel = labels.method;
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
            admin_granted: t`Made an administrator`,
            admin_revoked: t`No longer an administrator`,
            enabled: t`Enabled again`,
            handed_over: t`What they owned handed to someone who stays`,
            support_granted: t`Given the support role`,
            support_revoked: t`Support role taken away`,
            auditor_granted: t`Given the auditor role`,
            auditor_revoked: t`Auditor role taken away`,
            account_manager_granted: t`Given the account manager role`,
            account_manager_revoked: t`Account manager role taken away`,
            source_manager_granted: t`Given the source manager role`,
            source_manager_revoked: t`Source manager role taken away`,
            all_active: t`Every active account`,
            selected: t`Chosen accounts`,
            as_admin: t`As an administrator`,
            admin_revoke_session: t`One session`,
            admin_revoke_user: t`All their sessions`,
            admin_revoke_all: t`Everyone else`,
            every_token: t`Every token of the instance`,
            maintenance: t`Maintenance`,
            account_locked: t`Account locked`,
            admin_unlock: t`By an administrator`,
            self_service: t`Asked by the person`,
            self_service_token: t`Their own API token`,
            provider_logout: t`Signed out at the identity provider`,
            sso_only: t`Password access ended for single sign-on`,
            admin_reset: t`Link from an administrator`,
            reset_link: t`By an administrator`,
            // Requirements relaxed or back to strict (ADR 0140).
            "source.plaintext": t`A source without TLS`,
            "notify.private_networks": t`Channels on a private network`,
            // Settings that changed (settings_changed).
            signup: t`Sign-ups`,
            defaultLocale: t`Default language`,
            banner: t`Announcement`,
            mfaScope: t`Who needs a second factor`,
            ssoMfa: t`Second factor after single sign-on`,
            ssoOnly: t`Who may sign in with a password`,
            signInAllowlist: t`Sign-in addresses`,
            lockoutThreshold: t`Failed attempts before locking`,
            lockoutMinutes: t`Lock duration`,
            sessionIdleMinutes: t`Session idle timeout`,
            sessionMaxHours: t`Session lifetime`,
            passwordMinLength: t`Password length`,
            passwordReset: t`Password resets`,
            tokenMaxDays: t`API token lifetime`,
            publicLinks: t`Public links`,
            automationScripts: t`Scripts in automations`,
            trailToCollector: t`Change trail sent to the collectors`,
            signupDomains: t`Sign-up domains`,
            authRetentionDays: t`Sign-in trail retention`,
            invitations: t`Whom owners can invite`,
            baseCreation: t`Who can create bases`,
            apiTokens: t`Who can create API tokens`,
            inactiveDays: t`Disable accounts nobody uses`,
            limits: t`Limits and usage`,
            lockAlerts: t`Tell administrators`,
            auditRetentionDays: t`Change trail kept for`,
            trashDays: t`Trash kept for`,
            restorePointDays: t`Restore points kept for`,
            alertBackupHours: t`Alert: backup late`,
            alertStoragePercent: t`Alert: storage nearly full`,
            alertCertificateDays: t`Alert: certificate close to expiry`,
            alertSources: t`Alert: source out of reach`,
            alertFailures: t`Alert: failures piling up`,
            mapTileUrl: t`Map tiles`,
            mapTileCredit: t`Map tiles' credit`,
            instanceName: t`Name of the instance`,
            signInMessage: t`Note on the sign-in pages`,
            logo: t`Logo`,
            mailSenderName: t`Sender name`,
            mailSignatureEn: t`Signature, in English`,
            mailSignatureFr: t`Signature, in French`,
            mailInvitationEn: t`Note in invitations, in English`,
            mailInvitationFr: t`Note in invitations, in French`,
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
        action: search.action,
        from: search.from,
        to: search.to,
        direction: search.dir ?? "desc",
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
            reads
            id="sign-in-action"
            className="w-52"
            value={search.action ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onSearch((current) =>
                nextSignIns(current, {
                  action: SIGN_IN_ACTIONS.find((item) => item === value),
                }),
              );
            }}
          >
            <option value="">{t`All`}</option>
            {SIGN_IN_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <InstantRange
          from={search.from}
          to={search.to}
          invalid={invalid}
          onChange={(next) => onSearch((current) => nextSignIns(current, next))}
        />
        {readsAll ? (
          <Button
            reads
            size="sm"
            variant="outline"
            onClick={() => void exportCsv()}
          >
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
      {trail.isLoading && !invalid ? <Spinner /> : null}
      {invalid ? null : (
        <>
          <AdminTable tableClassName="text-xs">
            <AdminTableHead>
              <tr>
                <SortHeader
                  label={t`Date`}
                  active
                  descending={!oldestFirst}
                  onSort={() => onSearch(toggleSignInDir)}
                />
                <th className="px-2 py-1.5">{t`Event`}</th>
                <th className="px-2 py-1.5">{t`Account`}</th>
                <th className="px-2 py-1.5">{t`How`}</th>
                <th className="px-2 py-1.5">{t`By`}</th>
                <th className="px-2 py-1.5">{t`Address`}</th>
              </tr>
            </AdminTableHead>
            <tbody>
              {trail.data?.events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                    {t`No event matches. Sign-ins, failures, and what administrators change show here, with the address.`}
                  </td>
                </tr>
              ) : null}
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
          </AdminTable>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              reads
              size="sm"
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              {oldestFirst ? t`Older` : t`Newer`}
            </Button>
            <Button
              reads
              size="sm"
              variant="ghost"
              disabled={!trail.data?.next}
              onClick={() => {
                const next = trail.data?.next;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              {oldestFirst ? t`Newer` : t`Older`}
            </Button>
            <AdminPageSizeSelect
              size={pageSize}
              onChange={(size) => {
                setPageSize(size);
                setCursors([]);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
