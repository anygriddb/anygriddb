import { LINK_PERMISSIONS } from "@anygriddb/core";
import { Avatar, Button, Input, Label, Select, Tooltip } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { downloadJobFile, useTrackJob } from "../../lib/jobs";
import { useCatalog, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import {
  type CatalogBase,
  type Collaborator,
  grants,
  type Permission,
} from "../../lib/types";
import { ConfirmDialog } from "../shell/dialogs";
import { NotebookPage, RuledSection } from "../shell/notebook-page";
import { useInvalidateCatalog } from "../shell/sidebar";
import { GroupRoles } from "./group-roles";
import { BaseLinks } from "./base-links";
import { RoleOptions, useRoleChoiceLabel } from "./role-options";
import { RestorePoints } from "./restore-points";
import { useRoleLabel } from "./role-label";
import { TableRulesPanel } from "./table-rules-panel";
import { WebhooksPanel } from "./webhooks-panel";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { Earlier } from "../history/earlier";
import { useWhen } from "../../lib/i18n";

export function BaseSettings({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const when = useWhen();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const session = useSession();
  const invalidate = useInvalidateCatalog();
  const roleLabel = useRoleLabel();
  const choiceLabel = useRoleChoiceLabel();
  const base = catalog.data?.find((item) => item.id === baseId);
  const may = (permission: Permission) => grants(base?.role, permission);
  const manageMembers = may("members.manage");
  const manage = may("base.manage");
  const members = useQuery({
    ...api.catalog.members.queryOptions({ baseId }),
    enabled: manageMembers,
  });
  const collaborators = useQuery({
    ...api.catalog.collaborators.queryOptions({ baseId }),
    enabled: manageMembers,
  });
  const openAccess = useQuery({
    ...api.catalog.openAccess.queryOptions({ baseId }),
    enabled: manageMembers,
  });
  const people = useMemo(
    () =>
      new Map(
        (collaborators.data?.users ?? []).map((person) => [person.id, person]),
      ),
    [collaborators.data],
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("editor");
  const [description, setDescription] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const [exporting, setExporting] = useState(false);
  // The member about to be taken out of the base, once that is confirmed.
  const [removing, setRemoving] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  // The role an owner is about to take in place of their own, once that
  // is confirmed: nobody gives it back to themselves.
  const [lowering, setLowering] = useState<{
    email: string;
    /** One of the four by its key, or a made role by its id. */
    role: string;
  } | null>(null);
  const track = useTrackJob();

  async function exportSnapshot(withData: boolean) {
    setExporting(true);
    try {
      const { jobId } = await trpc.catalog.exportSnapshot.mutate({
        baseId,
        withData,
      });
      await track(jobId, {
        label: t`Base export`,
        onDone: (job) =>
          job.download
            ? {
                message: t`Export ready`,
                action: {
                  label: t`Download`,
                  onClick: () => downloadJobFile(job.id),
                },
              }
            : { message: t`Export ready` },
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setExporting(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.catalog.members.queryKey({ baseId }),
      });
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  if (!base) return null;
  return (
    <NotebookPage title={t`${{ name: base.name }} settings`}>
      <RuledSection title={t`Description`}>
        <textarea
          className="min-h-20 rounded-md border border-border bg-card p-2 text-sm"
          aria-label={t`Description`}
          disabled={!manage}
          value={description ?? base.description ?? ""}
          onChange={(event) => setDescription(event.target.value)}
        />
        {manage ? (
          <Button
            size="sm"
            className="self-start"
            disabled={description === null}
            onClick={async () => {
              try {
                await trpc.catalog.updateBase.mutate({
                  baseId,
                  description: description || null,
                });
                setDescription(null);
                await invalidate();
                toast.success(t`Saved`);
              } catch (cause) {
                toast.error(errorText(cause));
              }
            }}
          >
            {t`Save`}
          </Button>
        ) : null}
        {manage ? (
          <Earlier
            kind="base"
            id={baseId}
            seen={() => ({
              name: base.name,
              description: base.description,
            })}
            onReverted={() => invalidate()}
          />
        ) : null}
      </RuledSection>
      <RuledSection
        title={t`Members`}
        description={t`The base role applies to all of its tables.`}
      >
        {manageMembers ? (
          <>
            {(openAccess.data ?? []).map((open) => (
              <p
                key={open.userId}
                role="status"
                className="mb-2 rounded-sm border border-warning/40 bg-warning-surface px-3 py-2 text-sm"
              >
                {t`${{ name: open.displayName }}, an administrator, is not a member and can read this base until ${{ until: when.clock(open.expiresAt) }}, without changing anything. Their reason: ${{ reason: open.reason }}`}
              </p>
            ))}
            <ul className="divide-y divide-border">
              {(members.data ?? []).map((member) => (
                <li
                  key={member.userId}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <Avatar name={member.displayName} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{member.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.email}
                      {member.groups.length > 0
                        ? ` · ${t`through the group ${{ groups: member.groups.join(", ") }}`}`
                        : null}
                    </p>
                  </div>
                  {member.direct ? null : (
                    <span className="w-40 text-sm text-muted-foreground">
                      {roleLabel(member.role)}
                    </span>
                  )}
                  <Select
                    aria-label={t`Role`}
                    className={member.direct ? "w-40" : "hidden"}
                    value={member.given ?? ""}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (
                        member.userId === session.data?.id &&
                        member.role === "owner" &&
                        next !== "owner"
                      ) {
                        setLowering({ email: member.email, role: next });
                        return;
                      }
                      void run(() =>
                        trpc.catalog.grant.mutate({
                          baseId,
                          email: member.email,
                          role: next,
                        }),
                      );
                    }}
                  >
                    <RoleOptions />
                  </Select>
                  <Tooltip content={t`Remove ${{ name: member.displayName }}`}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t`Remove ${{ name: member.displayName }}`}
                      className={member.direct ? undefined : "invisible"}
                      onClick={() =>
                        setRemoving({
                          userId: member.userId,
                          name: member.displayName,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await trpc.catalog.invite.mutate({
                    baseId,
                    email,
                    role,
                  });
                  setEmail("");
                  if (result.status === "granted") {
                    toast.success(t`Access granted`);
                  } else {
                    setInviteLink(
                      result.token
                        ? `${window.location.origin}/invite/${result.token}`
                        : "",
                    );
                    toast.success(
                      result.mailed
                        ? t`Invitation emailed`
                        : t`Invitation created`,
                    );
                  }
                  await queryClient.invalidateQueries({
                    queryKey: api.catalog.invitations.queryKey({ baseId }),
                  });
                });
              }}
            >
              <div className="flex min-w-60 flex-1 flex-col gap-1">
                <Label htmlFor="invite-email">{t`Invite by email`}</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <Select
                aria-label={t`Role`}
                className="w-40"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <RoleOptions />
              </Select>
              <Button type="submit" disabled={!email}>
                {t`Invite`}
              </Button>
            </form>
            {inviteLink ? (
              <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-accent/40 p-2">
                <code className="min-w-0 flex-1 truncate text-xs">
                  {inviteLink}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => copy(inviteLink, t`Link copied`)}
                >
                  {t`Copy`}
                </Button>
              </div>
            ) : null}
            <PendingInvitations baseId={baseId} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t`Your role: ${{ role: roleLabel(base.role) }}`}
          </p>
        )}
      </RuledSection>
      {LINK_PERMISSIONS.base.every(may) ? <BaseLinks baseId={baseId} /> : null}
      {manageMembers ? (
        <RuledSection
          title={t`Groups`}
          description={t`Groups come from Administration or your identity provider. Each member gets the group's role, and loses it on leaving the group.`}
        >
          <GroupRoles baseId={baseId} />
        </RuledSection>
      ) : null}
      {manage && may("data.export") ? (
        <RuledSection
          title={t`Backup`}
          description={t`A file to keep elsewhere: schema, views, dashboards, rows, members, and attachments, in a .zip archive. Import it again from “New base”: its rows come back as drafts, dated from the import. Comments, the history of changes, automations, webhooks, and public links stay with this base.`}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || base.tables.length === 0}
              onClick={() => void exportSnapshot(true)}
            >
              <Download className="h-4 w-4" aria-hidden />
              {t`Export with data`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={exporting || base.tables.length === 0}
              onClick={() => void exportSnapshot(false)}
            >
              {t`Export schema only`}
            </Button>
          </div>
          {base.tables.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t`Add at least one table before exporting.`}
            </p>
          ) : null}
        </RuledSection>
      ) : null}
      {manage ? (
        <RestorePoints
          baseId={baseId}
          hasTables={base.tables.length > 0}
          restores={may("data.export")}
        />
      ) : null}
      {manageMembers ? (
        <RuledSection
          title={t`Per-table access`}
          description={t`A table override replaces the base role either way. A member's permissions then narrow the rows they see and what they may do with each field.`}
        >
          {base.tables.map((table) => (
            <TableAccess
              key={table.id}
              tableId={table.id}
              name={table.name}
              columns={table.columns}
              people={people}
            />
          ))}
        </RuledSection>
      ) : null}
      {may("webhooks.manage") && may("data.export") ? (
        <RuledSection
          title={t`Webhooks`}
          description={t`Signed HTTPS POST (HMAC-SHA256) or email, on every write.`}
        >
          {base.tables.map((table) => (
            <div key={table.id} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{table.name}</h3>
              <WebhooksPanel
                tableId={table.id}
                columns={table.columns}
                people={people}
              />
            </div>
          ))}
        </RuledSection>
      ) : null}
      <BaseMutes baseId={baseId} tables={base.tables} />
      {lowering ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setLowering(null)}
          title={t`Stop being an owner of ${{ base: base.name }}?`}
          description={t`You become its ${{ role: choiceLabel(lowering.role) }} at once, and no longer manage it: its members, its settings, its tables and their fields. Only another owner can make you an owner again.`}
          confirmLabel={t`Lower my role`}
          onConfirm={async () => {
            await trpc.catalog.grant.mutate({
              baseId,
              email: lowering.email,
              role: lowering.role,
            });
            // The list of bases first: it says the role, and with it
            // what this page may still ask.
            await invalidate();
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t`Remove ${{ name: removing.name }} from ${{ base: base.name }}?`}
          description={t`They lose their own role on the base and its tables at once, with the permissions set for them on each table, and their open pages reload. A role a group gives them stays.`}
          confirmLabel={t`Remove`}
          onConfirm={() =>
            run(() =>
              trpc.catalog.revoke.mutate({ baseId, userId: removing.userId }),
            )
          }
        />
      ) : null}
    </NotebookPage>
  );
}

/**
 * The signed-in person's mutes on this base and its tables: each button
 * says what it does now, and does the other once pressed.
 */
function BaseMutes({
  baseId,
  tables,
}: {
  baseId: string;
  tables: ReadonlyArray<{ id: string; name: string }>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const preferences = useQuery(api.notifications.preferences.queryOptions());
  const mutes = preferences.data?.mutes ?? [];
  const muteOf = (tableId: string | null) =>
    mutes.find((mute) => mute.baseId === baseId && mute.tableId === tableId);

  async function toggle(tableId: string | null) {
    const muted = muteOf(tableId);
    const change = muted
      ? () => trpc.notifications.removeMute.mutate({ id: muted.id })
      : () =>
          trpc.notifications.addMute.mutate(
            tableId ? { baseId, tableId } : { baseId },
          );
    try {
      await change();
      await queryClient.invalidateQueries({
        queryKey: api.notifications.preferences.queryKey(),
      });
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <RuledSection
      title={t`Your notifications`}
      description={t`Mute this base, or one of its tables, so mentions, replies and assignments from there stay quiet. Change channels on your account page.`}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!preferences.data}
          onClick={() => void toggle(null)}
        >
          {muteOf(null) ? t`Unmute this base` : t`Mute this base`}
        </Button>
        {tables.map((table) => (
          <Button
            key={table.id}
            size="sm"
            variant="outline"
            disabled={!preferences.data}
            onClick={() => void toggle(table.id)}
          >
            {muteOf(table.id)
              ? t`Unmute ${{ name: table.name }}`
              : t`Mute ${{ name: table.name }}`}
          </Button>
        ))}
      </div>
    </RuledSection>
  );
}

function PendingInvitations({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const roleLabel = useRoleLabel();
  const pending = useQuery(api.catalog.invitations.queryOptions({ baseId }));
  const list = pending.data?.invitations ?? [];
  if (list.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">
        {t`Pending invitations`}
      </p>
      <ul className="divide-y divide-border text-sm">
        {list.map((invitation) => (
          <li key={invitation.id} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate">{invitation.email}</span>
            <span className="text-xs text-muted-foreground">
              {roleLabel(invitation.role)}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                try {
                  await trpc.catalog.revokeInvitation.mutate({
                    baseId,
                    invitationId: invitation.id,
                  });
                } catch (cause) {
                  toast.error(errorText(cause));
                }
                await queryClient.invalidateQueries({
                  queryKey: api.catalog.invitations.queryKey({ baseId }),
                });
              }}
            >
              {t`Revoke`}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableAccess({
  tableId,
  name,
  columns,
  people,
}: {
  tableId: string;
  name: string;
  columns: CatalogBase["tables"][number]["columns"];
  /** The base's people by id, to name those a cell or a condition holds. */
  people: ReadonlyMap<string, Collaborator>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const roleLabel = useRoleLabel();
  const access = useQuery(api.catalog.tableAccess.queryOptions({ tableId }));
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{name}</h3>
      <ul className="divide-y divide-border text-sm">
        {(access.data?.people ?? []).map((person) => (
          <li key={person.userId} className="flex items-center gap-3 py-1.5">
            <Avatar name={person.displayName} />
            <span className="min-w-0 flex-1 truncate">
              {person.displayName}
            </span>
            <Select
              aria-label={t`Role on ${{ table: name }}`}
              className="h-8 w-48"
              value={person.tableGiven ?? ""}
              onChange={async (event) => {
                try {
                  await trpc.catalog.setTableRole.mutate({
                    tableId,
                    userId: person.userId,
                    role: event.target.value || null,
                  });
                  await queryClient.invalidateQueries({
                    queryKey: api.catalog.tableAccess.queryKey({ tableId }),
                  });
                } catch (cause) {
                  toast.error(errorText(cause));
                }
              }}
            >
              <option value="">
                {t`Inherited (${{ role: roleLabel(person.baseRole) }})`}
              </option>
              <RoleOptions />
            </Select>
          </li>
        ))}
      </ul>
      <TableRulesPanel
        tableId={tableId}
        tableName={name}
        columns={columns}
        members={access.data?.people ?? []}
        people={people}
      />
    </div>
  );
}
