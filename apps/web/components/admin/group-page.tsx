import {
  Button,
  Input,
  Label,
  ListPicker,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { useRoleLabel } from "../settings/role-label";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { AccountName, useAccountChoices } from "./account-choices";
import { useBaseChoices } from "./base-choices";

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

/**
 * One group's page in Administration (ROADMAP #27): members, bases where
 * it holds a role, and for a local group the ways to change them.
 */
export function GroupAdminPage({ groupId }: { groupId: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const roleLabel = useRoleLabel();
  const detail = useQuery(api.admin.groups.get.queryOptions({ groupId }));
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [pickingMember, setPickingMember] = useState(false);
  const [memberTyped, setMemberTyped] = useState("");
  const [pickingBase, setPickingBase] = useState(false);
  const [baseTyped, setBaseTyped] = useState("");
  const [baseRole, setBaseRole] = useState<Role>("viewer");
  const members = useAccountChoices(memberTyped, pickingMember);
  const bases = useBaseChoices(baseTyped, pickingBase);

  const back = (
    <Link
      to="/admin/people/groups"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {t`Groups`}
    </Link>
  );

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <LoadFailed
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }
  if (!detail.data) return <Spinner />;

  const group = detail.data;
  const local = group.provider === null;
  const memberIds = new Set(group.members.map((row) => row.userId));
  const roleBaseIds = new Set(group.roles.map((row) => row.baseId));
  const memberOptions = members.options.filter(
    (option) => !memberIds.has(option.id),
  );
  const baseOptions = bases.options.filter(
    (option) => !roleBaseIds.has(option.id),
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.admin.groups.get.queryKey({ groupId }),
      }),
      queryClient.invalidateQueries({
        queryKey: api.admin.groups.list.queryKey(),
      }),
    ]);

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await action();
      await refresh();
      if (done) toast.success(done);
      return true;
    } catch (cause) {
      toast.error(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {group.displayName}
          </h2>
          <p className="text-sm text-muted-foreground">
            {local ? t`Local group` : t`Managed by your identity provider`}
            {group.description ? ` · ${group.description}` : null}
          </p>
        </div>
        {local ? (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setName(group.displayName);
                setDescription(group.description ?? "");
                setEditing(true);
              }}
            >
              {t`Edit`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-danger"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              {t`Delete…`}
            </Button>
          </div>
        ) : null}
      </header>

      {editing ? (
        <form
          className="flex flex-col gap-3 rounded-sm border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                trpc.admin.groups.update.mutate({
                  groupId,
                  displayName: name.trim(),
                  description: description.trim() || null,
                }),
              t`Group updated`,
            ).then((ok) => {
              if (ok) setEditing(false);
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-group-name">{t`Name`}</Label>
            <Input
              id="edit-group-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-group-description">{t`Description`}</Label>
            <Textarea
              id="edit-group-description"
              value={description}
              maxLength={500}
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              {t`Save`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t`Cancel`}
            </Button>
          </div>
        </form>
      ) : null}

      <section className="flex flex-col gap-2" aria-labelledby="group-members">
        <h3 id="group-members" className="text-sm font-semibold">
          {t`Members`}
        </h3>
        {group.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {local
              ? t`No member yet. Add one below.`
              : t`No member in this group.`}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {group.members.map((member) => (
              <li
                key={member.userId}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <Link
                  to="/admin/people/accounts/$userId"
                  params={{ userId: member.userId }}
                  className="min-w-0 hover:underline"
                >
                  <AccountName name={member.displayName} email={member.email} />
                </Link>
                {local ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t`Remove ${{ name: member.displayName }}`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          trpc.admin.groups.removeMember.mutate({
                            groupId,
                            userId: member.userId,
                          }),
                        t`Member removed`,
                      )
                    }
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {local && !pickingMember ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setPickingMember(true)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t`Add a member`}
          </Button>
        ) : null}
        {local && pickingMember ? (
          <div className="flex flex-col gap-2 rounded-sm border border-border p-2">
            <ListPicker
              label={t`Find an account`}
              listLabel={t`Accounts`}
              inputValue={memberTyped}
              onInputChange={setMemberTyped}
              options={memberOptions}
              selectionMode="single"
              selected={[]}
              onToggle={(id) => {
                void run(
                  () =>
                    trpc.admin.groups.addMember.mutate({ groupId, userId: id }),
                  t`Member added`,
                ).then((ok) => {
                  if (!ok) return;
                  setPickingMember(false);
                  setMemberTyped("");
                });
              }}
              className="max-h-48"
              empty={
                members.loading ? (
                  <span className="flex justify-center">
                    <Spinner />
                  </span>
                ) : (
                  t`No account by that name`
                )
              }
            />
            <Button
              size="sm"
              variant="ghost"
              className="self-end"
              onClick={() => {
                setPickingMember(false);
                setMemberTyped("");
              }}
            >
              {t`Cancel`}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="group-bases">
        <h3 id="group-bases" className="text-sm font-semibold">
          {t`Roles on bases`}
        </h3>
        {group.roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t`No base gives this group a role yet.`}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {group.roles.map((row) => (
              <li
                key={row.baseId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <Link
                  to="/admin/bases/$baseId"
                  params={{ baseId: row.baseId }}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {row.baseName}
                </Link>
                <span className="flex items-center gap-1">
                  <Select
                    aria-label={t`Role on ${{ base: row.baseName }}`}
                    className="w-36"
                    value={row.role}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value as Role;
                      void run(
                        () =>
                          trpc.admin.groups.setBaseRole.mutate({
                            groupId,
                            baseId: row.baseId,
                            role: next,
                          }),
                        t`Role changed`,
                      );
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
                    aria-label={t`Remove from ${{ base: row.baseName }}`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          trpc.admin.groups.setBaseRole.mutate({
                            groupId,
                            baseId: row.baseId,
                            role: null,
                          }),
                        t`Role removed`,
                      )
                    }
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {!pickingBase ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setPickingBase(true)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t`Give a role on a base`}
          </Button>
        ) : (
          <div className="flex flex-col gap-2 rounded-sm border border-border p-2">
            <ListPicker
              label={t`Find a base`}
              listLabel={t`Bases of the instance`}
              inputValue={baseTyped}
              onInputChange={setBaseTyped}
              options={baseOptions}
              selectionMode="single"
              selected={[]}
              onToggle={(id) => {
                const chosen = bases.found.find((base) => base.id === id);
                if (!chosen) return;
                void run(
                  () =>
                    trpc.admin.groups.setBaseRole.mutate({
                      groupId,
                      baseId: chosen.id,
                      role: baseRole,
                    }),
                  t`Role given on ${{ base: chosen.name }}`,
                ).then((ok) => {
                  if (!ok) return;
                  setPickingBase(false);
                  setBaseTyped("");
                  setBaseRole("viewer");
                });
              }}
              className="max-h-48"
              empty={
                bases.loading ? (
                  <span className="flex justify-center">
                    <Spinner />
                  </span>
                ) : (
                  t`No base by that name`
                )
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Select
                aria-label={t`Role`}
                className="w-36"
                value={baseRole}
                onChange={(event) => setBaseRole(event.target.value as Role)}
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
                onClick={() => {
                  setPickingBase(false);
                  setBaseTyped("");
                  setBaseRole("viewer");
                }}
              >
                {t`Cancel`}
              </Button>
            </div>
          </div>
        )}
      </section>

      {deleting ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDeleting(false)}
          title={t`Delete ${{ name: group.displayName }}?`}
          description={
            group.roles.length === 0
              ? t`The group and its membership are removed. This cannot be undone.`
              : t`The group leaves these bases, and its members lose the roles it gave them: ${{
                  bases: group.roles.map((row) => row.baseName).join(", "),
                }}. This cannot be undone.`
          }
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            try {
              await trpc.admin.groups.delete.mutate({ groupId });
              await queryClient.invalidateQueries({
                queryKey: api.admin.groups.list.queryKey(),
              });
              toast.success(t`Group deleted`);
              void navigate({ to: "/admin/people/groups" });
            } catch (cause) {
              toast.error(errorText(cause));
              throw cause;
            }
          }}
        />
      ) : null}

      <p className="text-xs text-muted-foreground">
        {plural(group.members.length, {
          one: `# member`,
          other: `# members`,
        })}
        {" · "}
        {plural(group.roles.length, {
          one: `# base`,
          other: `# bases`,
        })}
      </p>
    </div>
  );
}
