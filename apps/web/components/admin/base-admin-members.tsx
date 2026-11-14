import { Button, ListPicker, Select, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { useRoleLabel } from "../settings/role-label";
import { ConfirmDialog } from "../shell/dialogs";
import { useGiveBaseRole } from "./give-base-role";
import {
  AccountName,
  useAccountChoices,
  type AccountChoice,
} from "./account-choices";
import { useStepUp } from "./step-up";

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

type Member = {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  direct: boolean;
  groups: string[];
};

/**
 * The members of one base in Administration (ROADMAP #69): a person's own
 * role given, changed, or taken away without being a member of the base.
 * A role a group gives is shown, and changes with the group.
 */
export function BaseAdminMembers({
  baseId,
  baseName,
  members,
}: {
  baseId: string;
  baseName: string;
  members: readonly Member[];
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const stepUp = useStepUp();
  const roleLabel = useRoleLabel();
  const canChange = session.data?.isAdmin === true;
  const [removing, setRemoving] = useState<Member | null>(null);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState("");
  const [chosen, setChosen] = useState<AccountChoice | null>(null);
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const choices = useAccountChoices(typed, picking);
  const giving = useGiveBaseRole();
  const already = new Set(
    members.filter((member) => member.direct).map((member) => member.userId),
  );
  const options = choices.options.filter((option) => !already.has(option.id));

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.baseOverview.get.queryKey({ baseId }),
    });

  async function setOn(userId: string, next: Role): Promise<boolean> {
    setBusy(true);
    try {
      if (!(await stepUp.ensure())) return false;
      if (!(await giving.give({ userId, baseId, role: next }))) return false;
      await refresh();
      return true;
    } catch (cause) {
      toast.error(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const closePicker = () => {
    setPicking(false);
    setChosen(null);
    setTyped("");
    setRole("viewer");
  };

  return (
    <section className="flex flex-col gap-2" aria-labelledby="base-members">
      <h3 id="base-members" className="text-sm font-semibold">
        {t`Members`}
      </h3>
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs">
            <tr>
              <th className="px-3 py-2">{t`Account`}</th>
              <th className="px-3 py-2">{t`Role`}</th>
              {canChange ? <th className="w-10 px-3 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link
                    to="/admin/people/accounts/$userId"
                    params={{ userId: member.userId }}
                    className="font-medium hover:underline"
                  >
                    {member.displayName}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {member.email}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {member.direct && canChange ? (
                    <Select
                      aria-label={t`Role for ${{ name: member.displayName }}`}
                      className="w-36"
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => {
                        const next = event.target.value as Role;
                        void setOn(member.userId, next).then((done) => {
                          if (done) toast.success(t`Role changed`);
                        });
                      }}
                    >
                      {ROLES.map((option) => (
                        <option key={option} value={option}>
                          {roleLabel(option)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    roleLabel(member.role)
                  )}
                  {member.groups.length > 0 ? (
                    <span className="block text-muted-foreground">
                      {t`Through ${{ groups: member.groups.join(", ") }}`}
                    </span>
                  ) : null}
                </td>
                {canChange ? (
                  <td className="px-3 py-2">
                    {member.direct ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t`Remove ${{ name: member.displayName }}`}
                        onClick={() => setRemoving(member)}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canChange && !picking ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setPicking(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t`Give a role to someone`}
        </Button>
      ) : null}
      {canChange && picking ? (
        <div className="flex flex-col gap-2 rounded-sm border border-border p-2">
          {chosen ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                <AccountName name={chosen.displayName} email={chosen.email} />
              </span>
              <Select
                aria-label={t`Role for ${{ name: chosen.displayName }}`}
                className="w-36"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {roleLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <ListPicker
              label={t`Find an account`}
              listLabel={t`Accounts of the instance`}
              inputValue={typed}
              onInputChange={setTyped}
              options={options}
              selectionMode="single"
              selected={[]}
              onToggle={(id) =>
                setChosen(
                  choices.found.find((account) => account.id === id) ?? null,
                )
              }
              className="max-h-48"
              empty={
                choices.loading ? (
                  <span className="flex justify-center">
                    <Spinner />
                  </span>
                ) : (
                  t`No account by that name`
                )
              }
            />
          )}
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={closePicker}>
              {t`Cancel`}
            </Button>
            {chosen ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void setOn(chosen.id, role).then((done) => {
                    if (!done) return;
                    toast.success(
                      t`Role given to ${{ name: chosen.displayName }}`,
                    );
                    closePicker();
                  })
                }
              >
                {t`Give the role`}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {removing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t`Remove ${{ name: removing.displayName }} from ${{ base: baseName }}?`}
          description={t`They lose their own role on the base and its tables at once, and their open pages reload. A role a group gives them stays.`}
          confirmLabel={t`Remove`}
          onConfirm={async () => {
            try {
              if (!(await stepUp.ensure())) return;
              await trpc.admin.removeBaseRole.mutate({
                userId: removing.userId,
                baseId,
              });
              await refresh();
              toast.success(
                t`Removed ${{ name: removing.displayName }} from the base`,
              );
            } catch (cause) {
              toast.error(errorText(cause));
              throw cause;
            }
          }}
        />
      ) : null}
      {stepUp.dialog}
      {giving.dialogs}
    </section>
  );
}
