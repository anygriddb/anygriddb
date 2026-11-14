import {
  Button,
  Input,
  Label,
  Spinner,
  Textarea,
  useReadOnly,
} from "@anygriddb/ui";
import {
  INSTANCE_LOGO_MAX_BYTES,
  INSTANCE_LOGO_TYPES,
  PRODUCT_NAME,
  type InstanceSettingsPatch,
} from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { BrandMark } from "../brand/brand-mark";
import { instanceLogoUrl } from "../brand/instance-mark";
import { LoadFailed } from "../shell/load-failed";

/** A file's bytes as base64, the form the logo travels in. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("unreadable file"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * How the instance presents itself (ADR 0072): its name, logo and note on
 * the screens, and the name, signature and invitation note of its mail.
 */
export function IdentityTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.settings.queryOptions());

  async function refresh() {
    await Promise.all(
      [api.admin.settings, api.auth.instance].map((procedure) =>
        queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
      ),
    );
  }
  async function save(patch: InstanceSettingsPatch) {
    try {
      await trpc.admin.updateSettings.mutate(patch);
      await refresh();
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
  const saved = settings.data;
  return (
    <div className="flex max-w-lg flex-col gap-8">
      <section
        className="flex flex-col gap-4"
        aria-labelledby="identity-screens"
      >
        <h2 id="identity-screens" className="text-sm font-semibold">
          {t`On the screens`}
        </h2>
        <ScreensForm
          key={`${saved.instanceName ?? ""}\n${saved.signInMessage ?? ""}`}
          name={saved.instanceName}
          message={saved.signInMessage}
          onSave={save}
        />
        <LogoSetting logo={saved.logo} onChanged={refresh} />
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="identity-mail">
        <h2 id="identity-mail" className="text-sm font-semibold">
          {t`In mail`}
        </h2>
        <MailForm
          key={[
            saved.mailSenderName,
            saved.mailSignatureEn,
            saved.mailSignatureFr,
            saved.mailInvitationEn,
            saved.mailInvitationFr,
          ].join("\n")}
          saved={saved}
          onSave={save}
        />
      </section>
    </div>
  );
}

/** A field with its label above and its hint below. */
function Field(props: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

function ScreensForm(props: {
  name: string | null;
  message: string | null;
  onSave: (patch: InstanceSettingsPatch) => Promise<void>;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(props.name ?? "");
  const [message, setMessage] = useState(props.message ?? "");
  const changed =
    name.trim() !== (props.name ?? "") ||
    message.trim() !== (props.message ?? "");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          instanceName: name.trim() || null,
          signInMessage: message.trim() || null,
        });
      }}
    >
      <Field
        id="identity-name"
        label={t`Name`}
        hint={t`Shown on the sign-in pages, at the top of the app, in the browser's tab, and in mail. Empty: ${PRODUCT_NAME}.`}
      >
        <Input
          id="identity-name"
          value={name}
          maxLength={80}
          placeholder={PRODUCT_NAME}
          aria-describedby="identity-name-hint"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        id="identity-message"
        label={t`Note on the sign-in pages`}
        hint={t`Under the name, for everyone who opens the sign-in pages, before they sign in: who the instance is for, whom to ask for an account.`}
      >
        <Textarea
          id="identity-message"
          rows={3}
          maxLength={500}
          value={message}
          aria-describedby="identity-message-hint"
          onChange={(event) => setMessage(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={!changed}
      >
        {t`Save the name and the note`}
      </Button>
    </form>
  );
}

function LogoSetting(props: {
  logo: string | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const off = busy || readOnly;

  async function act(change: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await change();
      await props.onChanged();
      toast.success(done);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    const known = (INSTANCE_LOGO_TYPES as readonly string[]).includes(
      file.type,
    );
    if (!known || file.size < 1 || file.size > INSTANCE_LOGO_MAX_BYTES) {
      toast.error(t`A logo is a PNG, JPEG, or WebP image of 256 KiB at most`);
      return;
    }
    const data = await readBase64(file);
    await act(() => trpc.admin.setLogo.mutate({ data }), t`Logo saved`);
  }

  return (
    <div className="flex flex-col gap-1">
      <span id="identity-logo-label" className="text-sm font-medium">
        {t`Logo`}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-card">
          {props.logo ? (
            <img
              src={instanceLogoUrl(props.logo)}
              alt={t`The logo in use`}
              className="h-8 w-8 object-contain"
            />
          ) : (
            <BrandMark className="h-8 w-8" title={PRODUCT_NAME} />
          )}
        </span>
        <label
          className={`inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium focus-within:ring-2 focus-within:ring-ring ${
            off
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:bg-muted"
          }`}
        >
          {busy ? <Spinner /> : <ImageUp className="h-4 w-4" aria-hidden />}
          {props.logo ? t`Choose another image` : t`Choose an image`}
          <input
            type="file"
            accept={INSTANCE_LOGO_TYPES.join(",")}
            className="sr-only"
            disabled={off}
            aria-describedby="identity-logo-hint"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) void upload(chosen);
              event.target.value = "";
            }}
          />
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={!props.logo || busy}
          onClick={() =>
            void act(() => trpc.admin.removeLogo.mutate(), t`Logo removed`)
          }
        >
          {t`Remove the logo`}
        </Button>
      </div>
      <p id="identity-logo-hint" className="text-xs text-muted-foreground">
        {t`A PNG, JPEG, or WebP image of 256 KiB at most. It is drawn small, in a square, wherever the mark above is: a symbol reads better than a name written out.`}
      </p>
    </div>
  );
}

function MailForm(props: {
  saved: {
    instanceName: string | null;
    mailSenderName: string | null;
    mailSignatureEn: string | null;
    mailSignatureFr: string | null;
    mailInvitationEn: string | null;
    mailInvitationFr: string | null;
    smtpReady: boolean;
  };
  onSave: (patch: InstanceSettingsPatch) => Promise<void>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const { saved } = props;
  const [sender, setSender] = useState(saved.mailSenderName ?? "");
  const [signatureEn, setSignatureEn] = useState(saved.mailSignatureEn ?? "");
  const [signatureFr, setSignatureFr] = useState(saved.mailSignatureFr ?? "");
  const [invitationEn, setInvitationEn] = useState(
    saved.mailInvitationEn ?? "",
  );
  const [invitationFr, setInvitationFr] = useState(
    saved.mailInvitationFr ?? "",
  );
  const [testing, setTesting] = useState(false);
  const changed =
    sender.trim() !== (saved.mailSenderName ?? "") ||
    signatureEn.trim() !== (saved.mailSignatureEn ?? "") ||
    signatureFr.trim() !== (saved.mailSignatureFr ?? "") ||
    invitationEn.trim() !== (saved.mailInvitationEn ?? "") ||
    invitationFr.trim() !== (saved.mailInvitationFr ?? "");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          mailSenderName: sender.trim() || null,
          mailSignatureEn: signatureEn.trim() || null,
          mailSignatureFr: signatureFr.trim() || null,
          mailInvitationEn: invitationEn.trim() || null,
          mailInvitationFr: invitationFr.trim() || null,
        });
      }}
    >
      <Field
        id="identity-sender"
        label={t`Sender name`}
        hint={t`The name before the sender's address. Empty: the instance's name, and without one the address alone.`}
      >
        <Input
          id="identity-sender"
          value={sender}
          maxLength={80}
          placeholder={saved.instanceName ?? ""}
          aria-describedby="identity-sender-hint"
          onChange={(event) => setSender(event.target.value)}
        />
      </Field>
      <Field id="identity-signature-en" label={t`Signature, in English`}>
        <Textarea
          id="identity-signature-en"
          rows={3}
          maxLength={1000}
          value={signatureEn}
          onChange={(event) => setSignatureEn(event.target.value)}
        />
      </Field>
      <Field
        id="identity-signature-fr"
        label={t`Signature, in French`}
        hint={t`Closes every mail the instance writes, in the language of the mail: who sends it, how to reach them. Mail an automation or a webhook sends keeps the text its author wrote.`}
      >
        <Textarea
          id="identity-signature-fr"
          rows={3}
          maxLength={1000}
          value={signatureFr}
          aria-describedby="identity-signature-fr-hint"
          onChange={(event) => setSignatureFr(event.target.value)}
        />
      </Field>
      <Field
        id="identity-invitation-en"
        label={t`Note in invitations, in English`}
      >
        <Textarea
          id="identity-invitation-en"
          rows={3}
          maxLength={2000}
          value={invitationEn}
          onChange={(event) => setInvitationEn(event.target.value)}
        />
      </Field>
      <Field
        id="identity-invitation-fr"
        label={t`Note in invitations, in French`}
        hint={t`Added to an invitation to a base, between the name of who invites and the link. The link and the day it expires are always there.`}
      >
        <Textarea
          id="identity-invitation-fr"
          rows={3}
          maxLength={2000}
          value={invitationFr}
          aria-describedby="identity-invitation-fr-hint"
          onChange={(event) => setInvitationFr(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!changed}>
          {t`Save the mail settings`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!saved.smtpReady || testing || changed}
          onClick={() =>
            void (async () => {
              setTesting(true);
              try {
                const sent = await trpc.admin.sendTestMail.mutate();
                toast.success(t`Test email sent to ${{ to: sent.to }}`);
              } catch (cause) {
                toast.error(errorText(cause));
              } finally {
                setTesting(false);
              }
            })()
          }
        >
          {t`Send me a test email`}
        </Button>
      </div>
      {saved.smtpReady ? null : (
        <p className="text-xs text-muted-foreground">
          {t`The instance sends no email yet: set it up under Connections.`}
        </p>
      )}
    </form>
  );
}
