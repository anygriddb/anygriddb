import { Button, Input, Label } from "@anygriddb/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";

/**
 * The person's name, which they change themselves; their address, which
 * an administrator changes. An identity provider that provisions the
 * account keeps both.
 */
export function ProfileForm(props: {
  displayName: string;
  email: string;
  nameManaged: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState(props.displayName);
  const [busy, setBusy] = useState(false);
  // A rename saved elsewhere (another tab) shows here unless one is typed.
  const [shown, setShown] = useState(props.displayName);
  if (shown !== props.displayName) {
    setShown(props.displayName);
    setName(props.displayName);
  }
  const changed = name.trim() !== "" && name.trim() !== props.displayName;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      await trpc.auth.rename.mutate({ displayName: name.trim() });
      await queryClient.invalidateQueries({
        queryKey: api.session.current.queryKey(),
      });
      toast.success(t`Name saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-md flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <Label htmlFor="profile-name">{t`Display name`}</Label>
        <div className="flex gap-2">
          <Input
            id="profile-name"
            autoComplete="name"
            maxLength={80}
            value={name}
            readOnly={props.nameManaged}
            onChange={(event) => setName(event.target.value)}
          />
          {props.nameManaged ? null : (
            <Button type="submit" variant="outline" disabled={busy || !changed}>
              {t`Save`}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="profile-email">{t`Email`}</Label>
        <Input id="profile-email" readOnly value={props.email} />
      </div>
      <p className="text-xs text-muted-foreground">
        {props.nameManaged
          ? t`Your organization's directory keeps your name and address: change them there.`
          : t`Others see this name in comments, history, and signatures. An administrator changes the address.`}
      </p>
    </form>
  );
}
