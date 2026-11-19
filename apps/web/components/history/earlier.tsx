import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useLocale } from "../../lib/i18n";
import { trpc, useTRPC } from "../../lib/trpc";
import { formatInstant } from "../../lib/format";

type Change = {
  field: string;
  before: string;
  after: string;
  canRevert: boolean;
};

type EarlierEvent = {
  id: string;
  occurredAt: string;
  displayName: string | null;
  actingName?: string | null;
  verb: "created" | "edited" | "removed";
  source: string | null;
  changes: Change[];
  canRevertAll: boolean;
};

/** The same list on a row, a base, a view, a dashboard, and the rest. */
function EarlierList(props: {
  events: readonly EarlierEvent[];
  /** What the whole-event button says. A row says it puts the row back. */
  allLabel?: string;
  onRevert: (eventId: string, field?: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const label = useFieldLabel();
  if (props.events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t`Nothing earlier yet.`}</p>
    );
  }
  async function revert(eventId: string, field?: string) {
    setBusy(field ? `${eventId}:${field}` : eventId);
    try {
      await props.onRevert(eventId, field);
    } finally {
      setBusy(null);
    }
  }
  return (
    <ul className="flex max-h-64 flex-col gap-3 overflow-auto">
      {props.events.map((event) => (
        <li key={event.id} className="text-sm">
          <p className="text-xs">
            <span className="font-medium">
              {event.actingName
                ? t`${event.displayName ?? "AnyGridDB"}, acting as ${event.actingName}`
                : (event.displayName ?? "AnyGridDB")}
            </span>{" "}
            {event.verb === "created"
              ? t`created`
              : event.verb === "removed"
                ? t`removed`
                : t`edited`}
            <span className="ml-1 text-muted-foreground">
              {formatInstant(event.occurredAt, locale)}
              {event.source === "revert" ? ` · ${t`put back`}` : ""}
            </span>
          </p>
          {event.changes.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {event.changes.map((change) => (
                <li
                  key={change.field}
                  className="rounded bg-muted px-2 py-1 text-xs"
                >
                  <span className="font-medium">{label(change.field)}</span>
                  {" : "}
                  <span className="text-danger line-through">
                    {shown(change.before)}
                  </span>
                  {" → "}
                  <span className="text-primary">{shown(change.after)}</span>
                  {change.canRevert ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-1 h-6 px-1 text-xs"
                      disabled={busy !== null}
                      onClick={() => void revert(event.id, change.field)}
                    >
                      {t`Put this value back`}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {event.canRevertAll ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 h-6 px-1 text-xs"
              disabled={busy !== null}
              onClick={() => void revert(event.id)}
            >
              {props.allLabel ?? t`Put this back`}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function shown(value: string): string {
  if (value === "") return "∅";
  return value.length > 280 ? `${value.slice(0, 280)}…` : value;
}

function useFieldLabel(): (field: string) => string {
  const { t } = useLingui();
  return (field) => {
    switch (field) {
      case "name":
        return t`Name`;
      case "description":
        return t`Description`;
      case "label":
        return t`Label`;
      case "config":
        return t`Configuration`;
      case "requireReason":
        return t`Require a reason`;
      case "required":
        return t`Required`;
      case "isUnique":
        return t`Unique values`;
      case "title":
        return t`Title`;
      case "kind":
        return t`Kind`;
      case "enabled":
      case "active":
        return t`Active`;
      case "trigger":
        return t`Trigger`;
      case "actions":
        return t`Actions`;
      case "events":
        return t`Events`;
      case "filter":
        return t`Filter`;
      case "watchColumns":
        return t`Watched fields`;
      case "includeValues":
        return t`Row values`;
      case "target":
        return t`Address`;
      default:
        return field;
    }
  };
}

type Kind =
  | "base"
  | "table"
  | "column"
  | "view"
  | "folder"
  | "dashboard"
  | "widget"
  | "automation"
  | "webhook";

/** Earlier versions of one catalog object, with the buttons that put them back. */
export function Earlier(props: {
  kind: Kind;
  id: string;
  seen: () => Record<string, unknown>;
  onReverted?: () => Promise<void> | void;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const earlier = useQuery({
    ...api.catalog.earlier.queryOptions({ kind: props.kind, id: props.id }),
    // A change just made must show when the list is opened again.
    staleTime: 0,
  });
  async function onRevert(eventId: string, field?: string) {
    try {
      await trpc.catalog.revert.mutate({
        kind: props.kind,
        id: props.id,
        eventId,
        ...(field ? { field } : {}),
        seen: props.seen(),
      });
      await queryClient.invalidateQueries({
        queryKey: api.catalog.earlier.queryKey({
          kind: props.kind,
          id: props.id,
        }),
      });
      await props.onReverted?.();
      toast.success(t`Put back`);
    } catch (cause) {
      toast.error(errorText(cause));
      await earlier.refetch();
    }
  }
  if (earlier.isLoading) {
    return <p className="text-xs text-muted-foreground">{t`Loading…`}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{t`Earlier`}</p>
      <EarlierList events={earlier.data?.events ?? []} onRevert={onRevert} />
    </div>
  );
}
