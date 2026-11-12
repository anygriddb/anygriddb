import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AtSign,
  Bell,
  CornerDownRight,
  Crown,
  LockKeyhole,
  UserPlus,
  Webhook,
  Zap,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useChannel } from "../../lib/realtime";
import { useSession } from "../../lib/session";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { useLingui } from "@lingui/react/macro";

type Item = RouterOutputs["notifications"]["list"]["notifications"][number];

const ICONS = {
  mention: AtSign,
  reply: CornerDownRight,
  assigned: UserPlus,
  automation: Zap,
  webhook_disabled: Webhook,
  row_changed: AlertTriangle,
  account_locked: LockKeyhole,
  owner_named: Crown,
} as const;

function useDescribe() {
  const { t } = useLingui();
  return (item: Item) => {
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
    }
  };
}

/** Unread count, list, and live updates on the user's own channel. */
export function NotificationBell() {
  const { t } = useLingui();
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const describe = useDescribe();
  const [open, setOpen] = useState(false);
  const options = api.notifications.list.queryOptions({ limit: 30 });
  const list = useQuery({ ...options, enabled: Boolean(session.data) });
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.notifications.list.queryKey(),
    });
  useChannel(session.data?.id, {
    message: (message) => {
      if (message.type === "notification") void refresh();
    },
    resync: () => {
      void refresh();
    },
  });
  const unread = list.data?.unread ?? 0;
  const items = list.data?.notifications ?? [];

  async function openItem(item: Item) {
    setOpen(false);
    if (!item.read) {
      await trpc.notifications.markRead.mutate({ ids: [item.id] });
      void refresh();
    }
    if (item.kind === "account_locked") {
      void navigate({
        to: "/admin/people/accounts",
        search: { status: "locked" },
      });
      return;
    }
    if (item.kind === "owner_named" && item.data?.baseId) {
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
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative shrink-0"
          aria-label={
            unread > 0
              ? t`Notifications (${{ count: unread }} unread)`
              : t`Notifications`
          }
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">{t`Notifications`}</span>
          {unread > 0 ? (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={async () => {
                await trpc.notifications.markRead.mutate({});
                void refresh();
              }}
            >
              {t`Mark all as read`}
            </button>
          ) : null}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {items.map((item) => {
            const Icon = ICONS[item.kind];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void openItem(item)}
                  className={cn(
                    "flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                    !item.read && "bg-accent/40",
                  )}
                >
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block">{describe(item)}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </span>
                  {!item.read ? (
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                      aria-label={t`Unread`}
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t`No notifications`}
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
