import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenuItem,
  Input,
  Label,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { useStepUp } from "./step-up";

/** What an account action needs to know of the account it acts on. */
export type AccountTarget = {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  isSupport: boolean;
  isAuditor: boolean;
  disabled: boolean;
  locked: boolean;
  hasPassword: boolean;
  signOn: boolean;
  /** Managed by an identity provider through SCIM, and not removed by it. */
  managed: boolean;
};

/** Every action on an account, in the order the page and the menu list them. */
export const ACCOUNT_ACTIONS = [
  "edit",
  "reset",
  "disable",
  "unlock",
  "admin",
  "support",
  "auditor",
  "sessions",
  "factors",
  "signOn",
  "tokens",
  "delete",
] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

/** Actions Support may take as well as an administrator (ADR 0054). */
const SUPPORT_ACTIONS = new Set<AccountAction>([
  "reset",
  "unlock",
  "sessions",
  "factors",
  "signOn",
  "tokens",
]);

type Availability = { ok: true } | { ok: false; reason: string };

/**
 * Account actions in one place: whether each applies to an account, and
 * why not when it does not (an action is never hidden, only disabled with
 * its reason), the words for it, and the dialogs that confirm it. The
 * accounts list and an account's page share them.
 */
export function useAccountActions({
  mails,
  onChanged,
}: {
  /** Whether the instance mails links: what the reset dialog says. */
  mails: boolean;
  /** After an action went through: the page of a deleted account leaves. */
  onChanged?: (action: AccountAction) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const copy = useCopy();
  const stepUp = useStepUp();
  const viewerIsAdmin = session.data?.isAdmin === true;
  const viewerIsSupport = session.data?.isSupport === true;
  const [open, setOpen] = useState<{
    target: AccountTarget;
    action: AccountAction;
  } | null>(null);
  const [handed, setHanded] = useState<{ name: string; link: string } | null>(
    null,
  );
  const [edit, setEdit] = useState({ displayName: "", email: "" });
  const [erase, setErase] = useState<{
    soleOwnerBases: Array<{ id: string; name: string }>;
    typed: string;
    successor: string;
  } | null>(null);

  const label = (action: AccountAction, target: AccountTarget): string =>
    ({
      edit: t`Edit name and email`,
      reset: target.hasPassword
        ? t`Send a password reset link`
        : t`Send the first link`,
      disable: target.disabled ? t`Enable` : t`Disable`,
      unlock: t`Unlock`,
      admin: target.isAdmin ? t`Remove administration` : t`Make administrator`,
      support: target.isSupport
        ? t`Remove the support role`
        : t`Give the support role`,
      auditor: target.isAuditor
        ? t`Remove the auditor role`
        : t`Give the auditor role`,
      sessions: t`Sign out everywhere`,
      factors: t`Remove their second factors`,
      signOn: t`Unlink single sign-on`,
      tokens: t`Revoke their API tokens`,
      delete: t`Delete account…`,
    })[action];

  const availability = (
    action: AccountAction,
    target: AccountTarget,
  ): Availability => {
    const self = target.id === session.data?.id;
    // Support has its own actions; an auditor has none (ADR 0071).
    if (!viewerIsAdmin && !(viewerIsSupport && SUPPORT_ACTIONS.has(action))) {
      return { ok: false, reason: t`Administrators only` };
    }
    if (self && action !== "edit") {
      return { ok: false, reason: t`Your own account: from your settings` };
    }
    switch (action) {
      case "edit":
        return target.managed
          ? { ok: false, reason: t`Managed by your identity provider` }
          : { ok: true };
      case "reset":
        return !target.hasPassword && (target.signOn || target.managed)
          ? { ok: false, reason: t`Signs in through its identity provider` }
          : { ok: true };
      case "unlock":
        return target.locked
          ? { ok: true }
          : { ok: false, reason: t`Not locked` };
      case "support":
        // Support helps people sign in (ADR 0054): an administrator can
        // already do all of it.
        return target.isAdmin && !target.isSupport
          ? { ok: false, reason: t`An administrator already can` }
          : { ok: true };
      case "auditor":
        // An auditor reads Administration: an administrator already does.
        return target.isAdmin && !target.isAuditor
          ? { ok: false, reason: t`An administrator already can` }
          : { ok: true };
      case "signOn":
        return target.signOn
          ? { ok: true }
          : { ok: false, reason: t`Not linked to single sign-on` };
      case "delete":
        return target.managed
          ? {
              ok: false,
              reason: t`Managed by your identity provider: remove it there first`,
            }
          : { ok: true };
      default:
        return { ok: true };
    }
  };

  async function refresh(target: AccountTarget, action: AccountAction) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: api.admin.users.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.admin.account.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: api.admin.authAudit.queryKey(),
      }),
      // One's own name or address shows in the app's corner.
      target.id === session.data?.id
        ? queryClient.invalidateQueries({
            queryKey: api.session.current.queryKey(),
          })
        : null,
    ]);
    onChanged?.(action);
  }

  async function start(target: AccountTarget, action: AccountAction) {
    if (!availability(action, target).ok) return;
    if (action === "edit") {
      setEdit({ displayName: target.displayName, email: target.email });
    }
    if (action === "delete") {
      try {
        const info = await trpc.admin.eraseInfo.query({ userId: target.id });
        setErase({
          soleOwnerBases: info.soleOwnerBases,
          typed: "",
          successor: "",
        });
      } catch (cause) {
        toast.error(errorText(cause));
        return;
      }
    }
    setOpen({ target, action });
  }

  /** The action as a menu item: always listed, disabled with its reason. */
  function menuItem(action: AccountAction, target: AccountTarget): ReactNode {
    const state = availability(action, target);
    const text = label(action, target);
    return (
      <DropdownMenuItem
        key={action}
        danger={action === "delete"}
        disabled={!state.ok}
        textValue={text}
        onSelect={() => void start(target, action)}
      >
        <span className="flex flex-col">
          <span>{text}</span>
          {state.ok ? null : (
            <span className="text-xs text-muted-foreground">
              {state.reason}
            </span>
          )}
        </span>
      </DropdownMenuItem>
    );
  }

  /** The words on a button in view, where the account is already named. */
  const shortLabel = (action: AccountAction, target: AccountTarget): string =>
    action === "edit"
      ? t`Edit`
      : action === "delete"
        ? t`Delete`
        : action === "reset" && target.hasPassword
          ? t`Send a reset link`
          : label(action, target);

  /**
   * The action as a button in view, for the everyday ones (ROADMAP #13).
   * One that does not apply is left out: the menu says why.
   */
  function button(action: AccountAction, target: AccountTarget): ReactNode {
    if (!availability(action, target).ok) return null;
    return (
      <Button
        key={action}
        size="sm"
        variant="ghost"
        className={action === "delete" ? "text-danger" : undefined}
        onClick={() => void start(target, action)}
      >
        {shortLabel(action, target)}
      </Button>
    );
  }

  /**
   * Asked right before a sensitive action goes to the server (ROADMAP
   * #28), once what was typed is in order: the password or the second
   * factor again, unless one was given in the last five minutes.
   */
  async function prove(): Promise<void> {
    if (!(await stepUp.ensure())) throw new Error("step_up_cancelled");
  }

  async function confirm(): Promise<void> {
    if (!open) return;
    const { target, action } = open;
    const userId = target.id;
    try {
      switch (action) {
        case "edit":
          await trpc.admin.updateAccount.mutate({
            userId,
            displayName: edit.displayName,
            email: edit.email.trim(),
          });
          toast.success(t`Saved`);
          break;
        case "reset": {
          const result = await trpc.admin.sendPasswordReset.mutate({ userId });
          if (result.sent) {
            toast.success(t`Link sent to ${{ to: result.to }}`);
          } else {
            setHanded({ name: target.displayName, link: result.link });
          }
          break;
        }
        case "disable":
          await prove();
          await trpc.admin.setDisabled.mutate({
            userId,
            disabled: !target.disabled,
          });
          toast.success(target.disabled ? t`Enabled` : t`Disabled`);
          break;
        case "unlock":
          await trpc.admin.unlock.mutate({ userId });
          toast.success(t`Unlocked`);
          break;
        case "admin":
          // Giving or taking away administration asks for the proof.
          await prove();
          await trpc.admin.setAdmin.mutate({ userId, admin: !target.isAdmin });
          toast.success(t`Saved`);
          break;
        case "support":
          await prove();
          await trpc.admin.setSupport.mutate({
            userId,
            support: !target.isSupport,
          });
          toast.success(t`Saved`);
          break;
        case "auditor":
          await prove();
          await trpc.admin.setAuditor.mutate({
            userId,
            auditor: !target.isAuditor,
          });
          toast.success(t`Saved`);
          break;
        case "sessions":
          await trpc.admin.endUserSessions.mutate({ userId });
          toast.success(t`Done`);
          break;
        case "factors":
          await prove();
          await trpc.admin.clearFactors.mutate({ userId });
          toast.success(t`Done`);
          break;
        case "signOn":
          await prove();
          await trpc.admin.unlinkSignOn.mutate({ userId });
          toast.success(t`Done`);
          break;
        case "tokens":
          await prove();
          await trpc.admin.revokeTokens.mutate({ userId });
          toast.success(t`Done`);
          break;
        case "delete": {
          if (!erase) return;
          if (erase.typed.trim().toLowerCase() !== target.email.toLowerCase()) {
            toast.error(t`Type the account's email to confirm`);
            throw new Error("confirm_email");
          }
          const handsOver = erase.soleOwnerBases.length > 0;
          if (handsOver && erase.successor.trim() === "") {
            toast.error(t`Type the new owner's email`);
            throw new Error("successor_email");
          }
          await prove();
          await trpc.admin.erase.mutate({
            userId,
            email: erase.typed.trim(),
            successorEmail: handsOver ? erase.successor.trim() : undefined,
          });
          toast.success(t`Account deleted`);
          break;
        }
      }
      await refresh(target, action);
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.message.endsWith("_email") ||
          cause.message === "step_up_cancelled")
      ) {
        throw cause;
      }
      toast.error(errorText(cause));
      throw cause;
    }
  }

  const close = (next: boolean) => {
    if (!next) {
      setOpen(null);
      setErase(null);
    }
  };

  function dialogText(action: AccountAction, target: AccountTarget) {
    const name = target.displayName;
    switch (action) {
      case "edit":
        return {
          title: t`Edit ${{ name }}'s account`,
          description: t`The name others see and the address they sign in with. A new address ends the reset links sent to the old one.`,
          confirm: t`Save`,
        };
      case "reset":
        return {
          title: target.hasPassword
            ? t`Send ${{ name }} a password reset link?`
            : t`Send ${{ name }} a new first link?`,
          description: mails
            ? t`The link sets a password once, within a day; their second factors stay. It goes to their address and you never see it.`
            : t`The link sets a password once, within a day; their second factors stay. Email is not set up, so you get the link to pass on: only to them, as it opens their account.`,
          confirm: mails ? t`Send` : t`Create the link`,
        };
      case "disable":
        return target.disabled
          ? {
              title: t`Enable ${{ name }}'s account again?`,
              description: t`The person will be able to sign in again.`,
              confirm: t`Enable`,
            }
          : {
              title: t`Disable ${{ name }}'s account?`,
              description: t`Their sessions end and their API tokens stop working. Their data and audit history are kept. When someone may come back, disable the account; delete it only when their identity must leave the instance.`,
              confirm: t`Disable`,
            };
      case "unlock":
        return {
          title: t`Unlock ${{ name }}'s account?`,
          description: t`The person can sign in again now, and their count of failed attempts starts over.`,
          confirm: t`Unlock`,
        };
      case "admin":
        return target.isAdmin
          ? {
              title: t`Remove ${{ name }}'s administration?`,
              description: t`They keep their account and their bases, and lose Administration. The instance always keeps one active administrator.`,
              confirm: t`Remove`,
            }
          : {
              title: t`Make ${{ name }} an administrator?`,
              description: t`They will manage every account, the instance's settings, and who sees which base. Their next action asks for a second factor.`,
              confirm: t`Make administrator`,
            };
      case "support":
        return target.isSupport
          ? {
              title: t`Remove ${{ name }}'s support role?`,
              description: t`They keep their account and their bases, and no longer open Administration.`,
              confirm: t`Remove`,
            }
          : {
              title: t`Give ${{ name }} the support role?`,
              description: t`They open the accounts, the sessions and the trails of Administration to help a person sign in again: send a link, unlock, sign out, remove second factors, unlink single sign-on, revoke tokens. They change no setting, give no role, and open no base they are not a member of.`,
              confirm: t`Give the role`,
            };
      case "auditor":
        return target.isAuditor
          ? {
              title: t`Remove ${{ name }}'s auditor role?`,
              description: t`They keep their account and their bases, and no longer open Administration.`,
              confirm: t`Remove`,
            }
          : {
              title: t`Give ${{ name }} the auditor role?`,
              description: t`They read every page of Administration: the accounts and their sign-ins, the groups, the bases and who reaches them, the sources, the settings, the trails. They change nothing there, and open no base they are not a member of. They may export the trails and the access report: each export is on the change trail under their name.`,
              confirm: t`Give the role`,
            };
      case "sessions":
        return {
          title: t`Sign ${{ name }} out everywhere?`,
          description: t`Every session of this account ends now. The person can sign in again.`,
          confirm: t`Sign out`,
        };
      case "factors":
        return {
          title: t`Remove ${{ name }}'s second factors?`,
          description: t`Their authenticator, passkeys, and backup codes are removed, and their sessions end. They sign in with their password and set up a second factor again. For a lost phone or key.`,
          confirm: t`Remove`,
        };
      case "signOn":
        return {
          title: t`Unlink ${{ name }} from single sign-on?`,
          description: t`The account forgets which identity of the provider it belongs to. The next sign-on with its address binds it again. For an account made again at the provider; otherwise someone else with that address there could take it.`,
          confirm: t`Unlink`,
        };
      case "tokens":
        return {
          title: t`Revoke ${{ name }}'s API tokens?`,
          description: t`Scripts and tools using these tokens stop working at once.`,
          confirm: t`Revoke`,
        };
      case "delete":
        return {
          title: t`Delete ${{ name }}'s account?`,
          description: t`This cannot be undone. Their email and factors are removed; audit history and comments stay under “Erased account”; row values in bases are kept. An active account is disabled first, in the same step.`,
          confirm: t`Delete`,
        };
    }
  }

  const text = open ? dialogText(open.action, open.target) : null;
  const dialogs = (
    <>
      {open && text ? (
        <ConfirmDialog
          open
          danger={
            open.action === "delete" ||
            open.action === "factors" ||
            open.action === "tokens" ||
            (open.action === "disable" && !open.target.disabled)
          }
          onOpenChange={close}
          title={text.title}
          description={text.description}
          confirmLabel={text.confirm}
          onConfirm={confirm}
        >
          {open.action === "edit" ? (
            <div className="flex flex-col gap-2 pb-3">
              <Label htmlFor="account-edit-name">{t`Display name`}</Label>
              <Input
                id="account-edit-name"
                autoComplete="off"
                maxLength={80}
                value={edit.displayName}
                onChange={(event) =>
                  setEdit({ ...edit, displayName: event.target.value })
                }
              />
              <Label htmlFor="account-edit-email">{t`Email`}</Label>
              <Input
                id="account-edit-email"
                type="email"
                autoComplete="off"
                maxLength={254}
                value={edit.email}
                onChange={(event) =>
                  setEdit({ ...edit, email: event.target.value })
                }
              />
            </div>
          ) : null}
          {open.action === "delete" && erase ? (
            <div className="flex flex-col gap-2">
              {erase.soleOwnerBases.length > 0 ? (
                <>
                  <p className="text-sm">
                    {t`No one else owns these bases: ${{ bases: erase.soleOwnerBases.map((base) => base.name).join(", ") }}. Name the active account that takes them.`}
                  </p>
                  <Label htmlFor="account-delete-successor">
                    {t`New owner's email`}
                  </Label>
                  <Input
                    id="account-delete-successor"
                    type="email"
                    autoComplete="off"
                    value={erase.successor}
                    onChange={(event) =>
                      setErase({ ...erase, successor: event.target.value })
                    }
                  />
                </>
              ) : null}
              <Label htmlFor="account-delete-email">
                {t`Type ${{ email: open.target.email }} to confirm`}
              </Label>
              <Input
                id="account-delete-email"
                type="email"
                autoComplete="off"
                value={erase.typed}
                onChange={(event) =>
                  setErase({ ...erase, typed: event.target.value })
                }
              />
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
      <HandedLink handed={handed} onClose={() => setHanded(null)} copy={copy} />
      {stepUp.dialog}
    </>
  );

  return {
    availability,
    label,
    menuItem,
    button,
    start,
    dialogs,
    /** Shows a link made without email, to pass on by hand. */
    hand: setHanded,
  };
}

/** A link the instance cannot mail, shown once to pass on by hand. */
function HandedLink({
  handed,
  onClose,
  copy,
}: {
  handed: { name: string; link: string } | null;
  onClose: () => void;
  copy: (text: string, done: string) => void;
}) {
  const { t } = useLingui();
  if (!handed) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t`Link for ${{ name: handed.name }}`}
        description={t`Email is not set up, so pass this link on yourself, to this person only: it lets whoever has it choose the account's password, once.`}
      >
        <textarea
          readOnly
          rows={2}
          aria-label={t`Link`}
          className="w-full resize-none rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={handed.link}
          onFocus={(event) => event.target.select()}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t`Done`}
          </Button>
          <Button onClick={() => copy(handed.link, t`Link copied`)}>
            {t`Copy the link`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
