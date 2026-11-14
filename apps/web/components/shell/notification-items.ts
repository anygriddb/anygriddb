import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  AtSign,
  CornerDownRight,
  Crown,
  DoorOpen,
  LockKeyhole,
  UserPlus,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { useRoleLabel } from "../settings/role-label";

export type NotificationItem =
  RouterOutputs["notifications"]["list"]["notifications"][number];

/** One icon per kind of notification, the bell's and the home page's. */
export const NOTIFICATION_ICONS = {
  mention: AtSign,
  reply: CornerDownRight,
  assigned: UserPlus,
  automation: Zap,
  webhook_disabled: Webhook,
  row_changed: AlertTriangle,
  account_locked: LockKeyhole,
  owner_named: Crown,
  admin_access: DoorOpen,
  role_given: Users,
} as const;

/** What a notification says, in one sentence. */
export function useDescribeNotification() {
  const { t } = useLingui();
  const roleLabel = useRoleLabel();
  return (item: NotificationItem) => {
    const actor = item.actorName ?? t`Someone`;
    const table = item.tableName ?? "—";
    switch (item.kind) {
      case "mention":
        return t`${actor} mentioned you in ${table}`;
      case "reply":
        return t`${actor} replied to your comment in ${table}`;
      case "assigned":
        return t`${actor} assigned you a row in ${table} (${{ field: item.data?.column ?? "—" }})`;
      case "automation":
        return item.data?.message
          ? t`${{ name: item.data.name ?? t`Automation` }}: ${{ message: item.data.message }}`
          : t`Automation in ${table}`;
      case "webhook_disabled":
        return t`Webhook ${{ name: item.data?.name ?? "" }} on ${table} was turned off after repeated failures`;
      case "row_changed":
        return t`Locked row ${{ row: item.data?.row ?? item.rowId ?? "—" }} of ${table} changed outside AnyGridDB`;
      case "account_locked":
        return item.data?.many
          ? t`Many accounts locked within an hour: see the sign-in trail`
          : t`${{ name: item.data?.name ?? "—" }}'s account locked after failed sign-ins`;
      case "owner_named":
        return t`${actor} made ${{ name: item.data?.name ?? "—" }} an owner of ${{ base: item.data?.base ?? "—" }}`;
      case "admin_access": {
        // An administrator let themselves into a base this person owns
        // (ADR 0074): for an hour to read it, or with a role.
        const base = item.data?.base ?? "—";
        const reason = item.data?.reason ?? "—";
        if (item.data?.until) {
          const until = new Date(item.data.until).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return t`${actor}, an administrator, opened ${base} to read it until ${until}. Their reason: ${reason}`;
        }
        const role = roleLabel((item.data?.role ?? "viewer") as Role);
        return t`${actor}, an administrator, gave themselves a role on ${base} (${role}). Their reason: ${reason}`;
      }
      case "role_given": {
        // An administrator gave a role on a base this person owns
        // (ROADMAP #91): to someone, to several, or through a group.
        const base = item.data?.base ?? "—";
        const name = item.data?.name ?? "—";
        const group = item.data?.group;
        const role = roleLabel(item.data?.role as Role | undefined);
        if (item.data?.count) {
          return t`${actor}, an administrator, gave ${{ count: item.data.count }} people a role on ${base}`;
        }
        if (group && item.data?.name) {
          return t`${actor}, an administrator, added ${name} to the group ${group}, which has a role on ${base} (${role})`;
        }
        if (group) {
          return t`${actor}, an administrator, gave the group ${group} a role on ${base} (${role})`;
        }
        return t`${actor}, an administrator, gave ${name} a role on ${base} (${role})`;
      }
    }
  };
}

/**
 * Opens what a notification is about, and marks it read: the row it names,
 * or the page that deals with it.
 */
export function useOpenNotification() {
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (item: NotificationItem) => {
    if (!item.read) {
      await trpc.notifications.markRead.mutate({ ids: [item.id] });
      void queryClient.invalidateQueries({
        queryKey: api.notifications.list.queryKey(),
      });
    }
    if (item.kind === "account_locked") {
      void navigate({
        to: "/admin/people/accounts",
        search: { status: "locked" },
      });
      return;
    }
    if (
      (item.kind === "owner_named" ||
        item.kind === "admin_access" ||
        item.kind === "role_given") &&
      item.data?.baseId
    ) {
      void navigate({
        to: "/b/$baseId/settings",
        params: { baseId: item.data.baseId },
      });
      return;
    }
    if (!item.baseId || !item.tableId) return;
    if (item.kind === "webhook_disabled") {
      void navigate({
        to: "/b/$baseId/settings",
        params: { baseId: item.baseId },
      });
      return;
    }
    void navigate({
      to: "/b/$baseId/t/$tableId/{-$viewId}",
      params: { baseId: item.baseId, tableId: item.tableId },
      search: { row: item.rowId ?? undefined },
    });
  };
}
