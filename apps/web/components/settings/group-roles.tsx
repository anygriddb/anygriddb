import { Button, Label, Select } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { givenValue } from "./role-label";
import { RoleOptions } from "./role-options";

/**
 * The roles a base gives to groups (local or from an identity provider):
 * each member gets the group's role, and loses it on leaving the group.
 */
export function GroupRoles(props: { baseId: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const data = useQuery(
    api.catalog.groupRoles.queryOptions({ baseId: props.baseId }),
  );
  const [groupId, setGroupId] = useState("");
  /** One of the four by its key, or a made role by its id. */
  const [role, setRole] = useState<string>("viewer");

  async function set(target: string, next: string | null) {
    try {
      await trpc.catalog.setGroupRole.mutate({
        baseId: props.baseId,
        groupId: target,
        role: next,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: api.catalog.groupRoles.queryKey({ baseId: props.baseId }),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.members.queryKey({ baseId: props.baseId }),
        }),
      ]);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  if (!data.data) return null;
  const given = new Set(data.data.roles.map((item) => item.groupId));
  const available = data.data.groups.filter((group) => !given.has(group.id));
  if (data.data.groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t`No group on this instance. An administrator can make one in Administration, or receive them from your identity provider (SCIM).`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border">
        {data.data.roles.map((item) => (
          <li
            key={item.groupId}
            className="flex items-center gap-3 py-2 text-sm"
          >
            <UsersRound className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.displayName}</p>
              <p className="text-xs text-muted-foreground">
                {plural(item.members, { one: `# member`, other: `# members` })}
              </p>
            </div>
            <Select
              aria-label={t`Role of the group ${{ name: item.displayName }}`}
              className="w-40"
              value={givenValue(item.role)}
              onChange={(event) => void set(item.groupId, event.target.value)}
            >
              <RoleOptions />
            </Select>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t`Remove the group ${{ name: item.displayName }}`}
              onClick={() => void set(item.groupId, null)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {available.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const target = groupId || available[0]?.id;
            if (target) void set(target, role).then(() => setGroupId(""));
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <Label htmlFor="group-role-group">{t`Give a group a role`}</Label>
            <Select
              id="group-role-group"
              value={groupId || available[0]?.id}
              onChange={(event) => setGroupId(event.target.value)}
            >
              {available.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.displayName} ({group.members})
                </option>
              ))}
            </Select>
          </div>
          <Select
            aria-label={t`Role`}
            className="w-40"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <RoleOptions />
          </Select>
          <Button type="submit">{t`Add the group`}</Button>
        </form>
      ) : null}
    </div>
  );
}
