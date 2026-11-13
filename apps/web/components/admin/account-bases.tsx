import { Button, ListPicker, Select, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { useRoleLabel } from "../settings/role-label";
import { ConfirmDialog } from "../shell/dialogs";
import { BaseName, useBaseChoices, type BaseChoice } from "./base-choices";
import { EffectiveRights } from "./effective-rights";

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

type Membership = {
  id: string;
  name: string;
  role: Role;
  /** The group that gives the role; null for the person's own. */
  viaGroup: string | null;
};

/**
 * A person's bases and roles on their Administration page (ROADMAP #68).
 * An administrator gives a role on any live base, changes the person's
 * own roles, or takes one away, each on the change trail under their name
 * (ADR 0057); a role a group gives is shown, and changes with the group.
 */
export function AccountBases({
  userId,
  name,
  bases,
  canChange,
}: {
  userId: string;
  name: string;
  bases: readonly Membership[];
  canChange: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const roleLabel = useRoleLabel();
  const [removing, setRemoving] = useState<Membership | null>(null);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState("");
  const [chosen, setChosen] = useState<BaseChoice | null>(null);
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [openRights, setOpenRights] = useState<string | null>(null);
  const choices = useBaseChoices(typed, picking);
  const own = new Set(
    bases.filter((base) => base.viaGroup === null).map((base) => base.id),
  );
  const options = choices.options.filter((option) => !own.has(option.id));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: api.admin.account.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.admin.users.queryKey() }),
    ]);
  async function setOn(baseId: string, next: Role): Promise<boolean> {
    setBusy(true);
    try {
      await trpc.admin.setBaseRole.mutate({ userId, baseId, role: next });
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
    <section className="flex flex-col gap-1.5 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">
        {t`Bases and roles`}
      </h3>
      {bases.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {canChange
            ? t`No base yet. Give them a role on one below.`
            : t`No base yet.`}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-sm border border-border">
          {bases.map((base) => {
            const rowKey = `${base.id}:${base.viaGroup ?? ""}`;
            const rightsOpen = openRights === rowKey;
            return (
              <li key={rowKey}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 text-left hover:underline"
                    aria-expanded={rightsOpen}
                    onClick={() => setOpenRights(rightsOpen ? null : rowKey)}
                  >
                    {rightsOpen ? (
                      <ChevronDown
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="truncate">{base.name}</span>
                  </button>
                  {base.viaGroup !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {t`${{ role: roleLabel(base.role) }}, through the group ${{ group: base.viaGroup }}`}
                    </span>
                  ) : canChange ? (
                    <span className="flex items-center gap-1">
                      <Select
                        aria-label={t`Role on ${{ base: base.name }}`}
                        className="w-36"
                        value={base.role}
                        disabled={busy}
                        onChange={(event) => {
                          const next = event.target.value as Role;
                          void setOn(base.id, next).then((done) => {
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
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t`Remove from ${{ base: base.name }}`}
                        onClick={() => setRemoving(base)}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {roleLabel(base.role)}
                    </span>
                  )}
                </div>
                {rightsOpen ? (
                  <EffectiveRights userId={userId} baseId={base.id} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canChange && !picking ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-1 self-start"
          onClick={() => setPicking(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t`Give a role on a base`}
        </Button>
      ) : null}
      {canChange && picking ? (
        <div className="mt-1 flex flex-col gap-2 rounded-sm border border-border p-2">
          {chosen ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                <BaseName
                  name={chosen.name}
                  owners={chosen.owners.join(", ")}
                />
              </span>
              <Select
                aria-label={t`Role on ${{ base: chosen.name }}`}
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
              label={t`Find a base`}
              listLabel={t`Bases of the instance`}
              inputValue={typed}
              onInputChange={setTyped}
              options={options}
              selectionMode="single"
              selected={[]}
              onToggle={(id) =>
                setChosen(choices.found.find((base) => base.id === id) ?? null)
              }
              className="max-h-48"
              empty={
                choices.loading ? (
                  <span className="flex justify-center">
                    <Spinner />
                  </span>
                ) : (
                  t`No base by that name`
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
                    toast.success(t`Role given on ${{ base: chosen.name }}`);
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
          title={t`Remove ${{ name }} from ${{ base: removing.name }}?`}
          description={t`They lose their own role on the base and its tables at once, and their open pages reload. A role a group gives them stays.`}
          confirmLabel={t`Remove`}
          onConfirm={async () => {
            try {
              await trpc.admin.removeBaseRole.mutate({
                userId,
                baseId: removing.id,
              });
              await refresh();
              toast.success(t`Removed from ${{ base: removing.name }}`);
            } catch (cause) {
              toast.error(errorText(cause));
              throw cause;
            }
          }}
        />
      ) : null}
    </section>
  );
}
