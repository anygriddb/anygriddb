import { Button, Input, Label, Spinner, Textarea } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";

/**
 * Groups of the instance (ROADMAP #27): local ones Administration keeps,
 * and those an identity provider sends through SCIM.
 */
export function GroupsTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const groups = useQuery(api.admin.groups.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  if (groups.isError) {
    return (
      <LoadFailed error={groups.error} onRetry={() => void groups.refetch()} />
    );
  }
  if (!groups.data) return <Spinner />;

  async function create() {
    const displayName = name.trim();
    if (!displayName) return;
    setBusy(true);
    try {
      const created = await trpc.admin.groups.create.mutate({
        displayName,
        description: description.trim() || null,
      });
      setName("");
      setDescription("");
      setCreating(false);
      await queryClient.invalidateQueries({
        queryKey: api.admin.groups.list.queryKey(),
      });
      toast.success(t`Group created`);
      return created.id;
    } catch (cause) {
      toast.error(errorText(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`Groups`}
        description={t`A group gathers accounts so a base can give them one role. Make a group here, or receive them from your identity provider (SCIM).`}
      >
        <div className="mb-3 flex justify-end">
          {creating ? null : (
            <Button size="sm" onClick={() => setCreating(true)} disabled={busy}>
              <Plus className="h-4 w-4" aria-hidden />
              {t`New group`}
            </Button>
          )}
        </div>
        {creating ? (
          <form
            className="mb-4 flex flex-col gap-3 rounded-sm border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="group-name">{t`Name`}</Label>
              <Input
                id="group-name"
                value={name}
                maxLength={80}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="group-description">{t`Description`}</Label>
              <Textarea
                id="group-description"
                value={description}
                maxLength={500}
                rows={2}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !name.trim()}>
                {t`Create`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setName("");
                  setDescription("");
                }}
              >
                {t`Cancel`}
              </Button>
            </div>
          </form>
        ) : null}
        {groups.data.groups.length === 0 ? (
          <p className="text-muted-foreground">
            {t`No group yet. Create one, or connect an identity provider under Provisioning.`}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {groups.data.groups.map((group) => (
              <li key={group.id}>
                <Link
                  to="/admin/people/groups/$groupId"
                  params={{ groupId: group.id }}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <UsersRound
                    className="h-5 w-5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{group.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {group.provider === null
                        ? t`Local`
                        : t`Identity provider`}
                      {group.description ? ` · ${group.description}` : null}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {plural(group.members, {
                      one: `# member`,
                      other: `# members`,
                    })}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                    {plural(group.bases, {
                      one: `# base`,
                      other: `# bases`,
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
    </div>
  );
}
