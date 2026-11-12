import { Button, buttonVariants, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CloudOff, Megaphone, Menu } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { JobsProvider } from "../../lib/jobs";
import { navigationMode, useNarrowScreen } from "../../lib/narrow-screen";
import {
  RealtimeProvider,
  useConnectionDown,
  useReconnect,
} from "../../lib/realtime";
import { useSession } from "../../lib/session";
import { useTRPC } from "../../lib/trpc";
import { safeNext } from "../auth/auth-page";
import { CommandPalette } from "./command-palette";
import { LoadFailed } from "./load-failed";
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
      className="flex items-start gap-2 border-b border-warning/40 bg-warning-surface px-4 py-2 text-sm"
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

/**
 * The page has had no realtime link for a while (ADR 0049): what it shows
 * may be out of date, and others' changes will not appear until it is
 * back. Editing goes on; the page re-reads itself once the link returns.
 */
function ConnectionBanner() {
  const { t } = useLingui();
  const down = useConnectionDown();
  const reconnect = useReconnect();
  if (!down) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning-surface px-4 py-2 text-sm"
    >
      <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1">
        {t`Connection lost: changes made by others will show once it is back.`}
      </p>
      <Button size="sm" variant="outline" onClick={reconnect}>
        {t`Reconnect now`}
      </Button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const session = useSession();
  const navigate = useNavigate();
  // On a narrow screen the navigation folds away and opens over the page.
  const narrow = useNarrowScreen();
  const page = useLocation({ select: (location) => location.pathname });
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const navigation = navigationMode(narrow, openedOn, page);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Closing gives focus back to the button that opened it.
    if (wasOpen.current && navigation === "closed") menuButton.current?.focus();
    wasOpen.current = navigation === "open";
  }, [navigation]);
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
  const onSetup = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname === "/welcome",
  });
  useEffect(() => {
    if (mustEnroll && !onSetup) {
      void navigate({ to: "/settings", replace: true });
    }
  }, [mustEnroll, onSetup, navigate]);
  if (!session.data) {
    if (session.isError) {
      return (
        <LoadFailed
          fullScreen
          error={session.error}
          onRetry={() => void session.refetch()}
        />
      );
    }
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
          <Sidebar
            user={session.data}
            mode={navigation}
            onClose={() => setOpenedOn(null)}
          />
          {navigation === "open" ? (
            <button
              type="button"
              aria-label={t`Close the navigation`}
              className="fixed inset-0 z-30 bg-foreground/30"
              onClick={() => setOpenedOn(null)}
            />
          ) : null}
          <div
            className="flex min-w-0 flex-1 flex-col overflow-hidden"
            inert={navigation === "open"}
          >
            {narrow ? (
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
                <button
                  ref={menuButton}
                  type="button"
                  className={buttonVariants({ size: "icon", variant: "ghost" })}
                  aria-label={t`Open the navigation`}
                  aria-expanded={navigation === "open"}
                  onClick={() => setOpenedOn(page)}
                >
                  <Menu className="h-4 w-4" aria-hidden />
                </button>
                <span className="truncate text-sm font-semibold">
                  AnyGridDB
                </span>
              </div>
            ) : null}
            <InstanceBanner />
            <ConnectionBanner />
            {children}
          </div>
        </div>
        <CommandPalette />
        <ShortcutsDialog />
      </JobsProvider>
    </RealtimeProvider>
  );
}
