import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTRPC } from "../../lib/trpc";

/** Shown while a channel has failed often enough to be paused (ADR 0092). */
export function NotificationsBanner() {
  const { t } = useLingui();
  const api = useTRPC();
  const failing = useQuery(api.admin.notify.failing.queryOptions());
  const count = failing.data?.count ?? 0;
  if (count < 1) return null;
  return (
    <p
      role="status"
      className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-sm"
    >
      {plural(count, {
        one: "An integration is failing and has stopped receiving events.",
        other: "# integrations are failing and have stopped receiving events.",
      })}{" "}
      <Link
        to="/admin/connections/notifications"
        className="text-primary underline"
      >
        {t`Review integrations`}
      </Link>
    </p>
  );
}
