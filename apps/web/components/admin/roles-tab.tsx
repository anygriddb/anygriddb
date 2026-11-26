import type { Permission } from "@anygriddb/core";
import { Button, Checkbox, Input, Label, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { usePermissionFamilies } from "./permission-labels";

type Draft = { id: string | null; name: string; permissions: Permission[] };

/**
 * The roles a base gives (ROADMAP #111, ADR 0128): the four as the packs
 * they are, and those an administrator makes of the same permissions.
 * Changing a made role changes the access of everyone who holds it, at
 * once; one somebody holds cannot be deleted.
 */
export function RolesTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const roleLabel = useRoleLabel();
  const families = usePermissionFamilies();
  const roles = useQuery(api.admin.roles.list.queryOptions());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  if (roles.isError) {
    return (
      <LoadFailed error={roles.error} onRetry={() => void roles.refetch()} />
    );
  }
  if (!roles.data) return <Spinner />;

  const label = new Map(
    families.flatMap((family) =>
      family.permissions.map((item) => [item.permission, item.label] as const),
    ),
  );
  const listOf = (permissions: readonly Permission[]) =>
    permissions.map((permission) => label.get(permission) ?? permission);
  /**
   * A new role of the same permissions (ADR 0131): a shipped role is never
   * changed, so one made from it is changed instead.
   */
  const duplicate = (name: string, permissions: readonly Permission[]) =>
    setDraft({
      id: null,
      name: t`${{ name }} (copy)`,
      permissions: [...permissions],
    });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.admin.roles.list.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: api.catalog.madeRoles.queryKey(),
      }),
    ]);
  }

  async function save(current: Draft) {
    setBusy(true);
    try {
      const input = {
        name: current.name.trim(),
        permissions: current.permissions,
      };
      if (current.id) {
        await trpc.admin.roles.update.mutate({ id: current.id, ...input });
        toast.success(t`Role changed`);
      } else {
        await trpc.admin.roles.create.mutate(input);
        toast.success(t`Role made`);
      }
      setDraft(null);
      setBusy(false);
      await refresh();
    } catch (cause) {
      setBusy(false);
      toast.error(errorText(cause));
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`Roles`}
        description={t`What a role gives someone on a base or a table. The four below come with every instance. Make others from the same permissions, then give them as the four are, from a base's settings or from here.`}
      >
        <ul className="divide-y divide-border rounded-sm border border-border">
          {roles.data.shipped.map((role) => (
            <li key={role.role} className="flex items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="font-medium">{roleLabel(role.role)}</p>
                <p className="text-xs text-muted-foreground">
                  {listOf(role.permissions).join(" · ")}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Duplicate the role ${{ name: roleLabel(role.role) }}`}
                disabled={busy || draft !== null}
                onClick={() =>
                  duplicate(roleLabel(role.role), role.permissions)
                }
              >
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      </RuledSection>
      <RuledSection
        title={t`Roles made here`}
        description={t`Everyone who holds a role gets what it gives now: a change takes effect at once. A role somebody holds, or that an invitation waits with, cannot be deleted.`}
      >
        <div className="mb-3 flex justify-end">
          {draft ? null : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                setDraft({ id: null, name: "", permissions: ["rows.read"] })
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t`New role`}
            </Button>
          )}
        </div>
        {draft ? (
          <form
            className="mb-4 flex flex-col gap-3 rounded-sm border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft);
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="role-name">{t`Name`}</Label>
              <Input
                id="role-name"
                value={draft.name}
                maxLength={60}
                autoFocus
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </div>
            {families.map((family) => (
              <fieldset key={family.label} className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">
                  {family.label}
                </legend>
                {family.permissions.map((item) => {
                  const id = `permission-${item.permission}`;
                  const always = item.permission === "rows.read";
                  return (
                    <div key={item.permission} className="flex gap-2">
                      <Checkbox
                        id={id}
                        aria-describedby={`${id}-hint`}
                        checked={draft.permissions.includes(item.permission)}
                        disabled={always}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            permissions: event.target.checked
                              ? [...draft.permissions, item.permission]
                              : draft.permissions.filter(
                                  (permission) =>
                                    permission !== item.permission,
                                ),
                          })
                        }
                      />
                      <div className="flex flex-col">
                        <Label htmlFor={id}>{item.label}</Label>
                        <span
                          id={`${id}-hint`}
                          className="text-xs text-muted-foreground"
                        >
                          {item.hint}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !draft.name.trim()}>
                {draft.id ? t`Save` : t`Create`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                {t`Cancel`}
              </Button>
            </div>
          </form>
        ) : null}
        {roles.data.made.length === 0 ? (
          <p className="text-muted-foreground">{t`No role made here yet.`}</p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {roles.data.made.map((role) => (
              <li key={role.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{role.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {listOf(role.permissions).join(" · ")}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {plural(role.holders, {
                    one: `# holder`,
                    other: `# holders`,
                  })}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Duplicate the role ${{ name: role.name }}`}
                  disabled={busy || draft !== null}
                  onClick={() => duplicate(role.name, role.permissions)}
                >
                  <Copy className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Change the role ${{ name: role.name }}`}
                  disabled={busy || draft !== null}
                  onClick={() =>
                    setDraft({
                      id: role.id,
                      name: role.name,
                      permissions: role.permissions,
                    })
                  }
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Delete the role ${{ name: role.name }}`}
                  disabled={busy || role.holders > 0}
                  onClick={() => setRemoving({ id: role.id, name: role.name })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
      {removing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t`Delete the role ${{ name: removing.name }}?`}
          description={t`Nobody holds it. Invitations already answered or expired that named it go with it.`}
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            await trpc.admin.roles.delete.mutate({ id: removing.id });
            setRemoving(null);
            toast.success(t`Role deleted`);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}
