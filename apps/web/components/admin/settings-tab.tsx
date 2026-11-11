import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import type { InstanceSettingsPatch } from "@anygriddb/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

export function SettingsTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.settings.queryOptions());
  const [banner, setBanner] = useState<string | null>(null);
  const [domains, setDomains] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  async function save(patch: InstanceSettingsPatch) {
    try {
      await trpc.admin.updateSettings.mutate(patch);
      await Promise.all(
        [api.admin.settings, api.auth.instance].map((procedure) =>
          queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
      toast.success(t`Settings saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  if (settings.isError) {
    return (
      <LoadFailed
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  if (!settings.data) return <Spinner />;
  const bannerText = banner ?? settings.data.banner ?? "";
  const savedDomains = settings.data.signupDomains.join(", ");
  const domainsText = domains ?? savedDomains;
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-maintenance">{t`Maintenance`}</Label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            id="setting-maintenance"
            checked={settings.data.maintenance}
            onChange={(event) => setMaintenance(event.target.checked)}
          />
          {t`Only administrators can sign in and work`}
        </label>
        <p className="text-xs text-muted-foreground">
          {t`For an upgrade or a restore. Turning it on signs everyone else out; their API tokens stop working until it is off.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-banner">{t`Announcement`}</Label>
        <Textarea
          id="setting-banner"
          rows={2}
          maxLength={500}
          placeholder={t`Shown at the top of the app to everyone signed in`}
          value={bannerText}
          onChange={(event) => setBanner(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={bannerText.trim() === (settings.data.banner ?? "")}
            onClick={() =>
              void save({ banner: bannerText.trim() || null }).then(() =>
                setBanner(null),
              )
            }
          >
            {t`Publish`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!settings.data.banner}
            onClick={() =>
              void save({ banner: null }).then(() => setBanner(null))
            }
          >
            {t`Remove`}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-signup">{t`Sign-ups`}</Label>
        <Select
          id="setting-signup"
          value={settings.data.signup}
          onChange={(event) =>
            void save({
              signup: event.target.value as "open" | "invite" | "closed",
            })
          }
        >
          <option value="open">{t`Open to anyone`}</option>
          <option value="invite">{t`By invitation to a base`}</option>
          <option value="closed">{t`Closed`}</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t`Open: anyone can register from the sign-in page. Closed: only administrators create accounts and send a reset link (Accounts). By invitation: a pending base invitation is required. SSO for new accounts follows the same rule. Existing accounts are not affected.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-domains">{t`Sign-up domains`}</Label>
        <Input
          id="setting-domains"
          placeholder="example.org, example.com"
          value={domainsText}
          onChange={(event) => setDomains(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={domains === null || domainsText === savedDomains}
            onClick={() =>
              void save({
                signupDomains: domainsText
                  .split(/[\s,;]+/)
                  .map((domain) => domain.trim())
                  .filter(Boolean),
              }).then(() => setDomains(null))
            }
          >
            {t`Save`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t`Only addresses of these domains can create an account on their own, by sign-up or SSO. Empty: any address. An owner's invitation still lets anyone in.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-locale">{t`Default language`}</Label>
        <Select
          id="setting-locale"
          value={settings.data.defaultLocale}
          onChange={(event) =>
            void save({ defaultLocale: event.target.value as "fr" | "en" })
          }
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t`Used until a person picks their own language.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-attachment-mb">{t`Largest attachment`}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="setting-attachment-mb"
            type="number"
            className="w-28"
            min={1}
            max={500}
            placeholder="20"
            aria-describedby="setting-attachment-mb-hint"
            defaultValue={
              settings.data.attachmentMaxBytes != null
                ? String(
                    Math.round(
                      settings.data.attachmentMaxBytes / (1024 * 1024),
                    ),
                  )
                : ""
            }
            key={String(settings.data.attachmentMaxBytes)}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              if (!raw) {
                if (settings.data.attachmentMaxBytes != null) {
                  void save({ attachmentMaxBytes: null });
                }
                return;
              }
              const mb = Number(raw);
              if (!Number.isFinite(mb) || mb < 1 || mb > 500) {
                // Out of bounds: the field shows what is saved again.
                event.target.value = event.target.defaultValue;
                return;
              }
              const bytes = Math.round(mb * 1024 * 1024);
              if (bytes !== settings.data.attachmentMaxBytes) {
                void save({ attachmentMaxBytes: bytes });
              }
            }}
          />
          <span className="text-sm text-muted-foreground">{t`MiB`}</span>
        </div>
        <p
          id="setting-attachment-mb-hint"
          className="text-xs text-muted-foreground"
        >
          {t`Empty uses the environment, then 20 MiB. Between 1 and 500.`}
        </p>
      </div>
      {maintenance !== null ? (
        <ConfirmDialog
          open
          danger={maintenance}
          onOpenChange={(open) => !open && setMaintenance(null)}
          title={
            maintenance ? t`Turn maintenance on?` : t`Turn maintenance off?`
          }
          description={
            maintenance
              ? t`Everyone but administrators is signed out now, and cannot sign in until you turn it off.`
              : t`Everyone can sign in again.`
          }
          confirmLabel={maintenance ? t`Turn on` : t`Turn off`}
          onConfirm={() => save({ maintenance })}
        />
      ) : null}
    </div>
  );
}
