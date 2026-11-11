import { Avatar, Button, Input, Label, Select } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { downloadJobFile, useTrackJob } from "../../lib/jobs";
import { useCatalog } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { canManage, type CatalogBase, type Role } from "../../lib/types";
import { NotebookPage, RuledSection } from "../shell/notebook-page";
import { useInvalidateCatalog } from "../shell/sidebar";
import { GroupRoles } from "./group-roles";
import { useRoleLabel } from "./role-label";
import { TableAclPanel } from "./table-acl-panel";
import { WebhooksPanel } from "./webhooks-panel";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];

export function BaseSettings({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const invalidate = useInvalidateCatalog();
  const roleLabel = useRoleLabel();
  const base = catalog.data?.find((item) => item.id === baseId);
  const manage = canManage(base?.role);
  const members = useQuery({
    ...api.catalog.members.queryOptions({ baseId }),
    enabled: manage,
  });
  const collaborators = useQuery({
    ...api.catalog.collaborators.queryOptions({ baseId }),
    enabled: manage,
  });
  const people = useMemo(
    () =>
      new Map(
        (collaborators.data?.users ?? []).map((person) => [person.id, person]),
      ),
    [collaborators.data],
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [description, setDescription] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const [exporting, setExporting] = useState(false);
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
      </RuledSection>
      <RuledSection
        title={t`Members`}
        description={t`The base role applies to all of its tables.`}
      >
        {manage ? (
          <>
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
                    value={member.role}
                    onChange={(event) =>
                      void run(() =>
                        trpc.catalog.grant.mutate({
                          baseId,
                          email: member.email,
                          role: event.target.value as Role,
                        }),
                      )
                    }
                  >
                    {ROLES.map((value) => (
                      <option key={value} value={value}>
                        {roleLabel(value)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Remove`}
                    className={member.direct ? undefined : "invisible"}
                    onClick={() =>
                      void run(() =>
                        trpc.catalog.revoke.mutate({
                          baseId,
                          userId: member.userId,
                        }),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
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
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(value)}
                  </option>
                ))}
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
      {manage ? (
        <RuledSection
          title={t`Groups`}
          description={t`Groups come from your identity provider. Each member gets the group's role, and loses it on leaving the group.`}
        >
          <GroupRoles baseId={baseId} roleLabel={(value) => roleLabel(value)} />
        </RuledSection>
      ) : null}
      {manage ? (
        <RuledSection
          title={t`Backup`}
          description={t`Portable file: schema, views, rows, members, and the attachments in a .zip archive when the base has some. Import it again from “New base”.`}
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
        <RuledSection
          title={t`Per-table access`}
          description={t`A table override replaces the base role either way. Field rights further restrict reading and writing.`}
        >
          {base.tables.map((table) => (
            <TableAccess
              key={table.id}
              tableId={table.id}
              name={table.name}
              columns={table.columns}
              people={[...(collaborators.data?.users ?? [])]}
            />
          ))}
        </RuledSection>
      ) : null}
      {manage ? (
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
    </NotebookPage>
  );
}

function PendingInvitations({ baseId }: { baseId: string }) {
  const { t } = useLingui();
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
                await trpc.catalog.revokeInvitation.mutate({
                  baseId,
                  invitationId: invitation.id,
                });
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
  people: Array<{ id: string; displayName: string; email?: string }>;
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
              value={person.tableRole ?? ""}
              onChange={async (event) => {
                try {
                  await trpc.catalog.setTableRole.mutate({
                    tableId,
                    userId: person.userId,
                    role: (event.target.value || null) as Role | null,
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
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      <TableAclPanel tableId={tableId} columns={columns} people={people} />
    </div>
  );
}
