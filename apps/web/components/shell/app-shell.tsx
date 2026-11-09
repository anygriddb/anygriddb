import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Megaphone } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { JobsProvider } from "../../lib/jobs";
import { RealtimeProvider } from "../../lib/realtime";
import { useSession } from "../../lib/session";
import { useTRPC } from "../../lib/trpc";
import { safeNext } from "../auth/auth-page";
import { CommandPalette } from "./command-palette";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Sidebar } from "./sidebar";

/**
 * What administrators tell everyone (ADR 0042): their announcement, and,
 * to the administrators still in, that maintenance is on.
 */
function InstanceBanner() {
  const { t } = useLingui();
  const api = useTRPC();
  const instance = useQuery({
    ...api.auth.instance.queryOptions(),
    refetchInterval: 60_000,
  });
  const banner = instance.data?.banner;
  const maintenance = instance.data?.maintenance;
  if (!banner && !maintenance) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <Megaphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="whitespace-pre-line">
        {maintenance ? (
          <span className="font-medium">
            {t`Maintenance is on: only administrators can sign in.`}{" "}
          </span>
        ) : null}
        {banner}
      </p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  // The page asked for, with its search, to come back to after sign-in.
  // While the router leaves for /login, `here` is already the sign-in
  // page: `safeNext` keeps it from nesting into its own `next`.
  const here = useLocation({ select: (location) => safeNext(location.href) });
  useEffect(() => {
    if (session.isSuccess && !session.data) {
      void navigate({ to: "/login", search: { next: here }, replace: true });
    }
  }, [session.isSuccess, session.data, navigate, here]);
  // The policy asks this account for a second factor before anything else
  // (ADR 0043): the account page is where it is set up.
  const mustEnroll = Boolean(
    session.data && session.data.mfaRequired && !session.data.mfaEnrolled,
  );
  const onSettings = useLocation({
    select: (location) => location.pathname === "/settings",
  });
  useEffect(() => {
    if (mustEnroll && !onSettings) {
      void navigate({ to: "/settings", replace: true });
    }
  }, [mustEnroll, onSettings, navigate]);
  if (!session.data) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <RealtimeProvider enabled>
      <JobsProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar user={session.data} />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <InstanceBanner />
            {children}
          </div>
        </div>
        <CommandPalette />
        <ShortcutsDialog />
      </JobsProvider>
    </RealtimeProvider>
  );
}
