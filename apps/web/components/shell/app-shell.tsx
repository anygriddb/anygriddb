import { Button, buttonVariants, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CloudOff, Megaphone, Menu } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useWhen } from "../../lib/i18n";
import { JobsProvider } from "../../lib/jobs";
import { navigationMode, useNarrowScreen } from "../../lib/narrow-screen";
import {
  RealtimeProvider,
  useConnectionDown,
  useReconnect,
} from "../../lib/realtime";
import { mayRead, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { onSignIn, safeNext } from "../auth/auth-page";
import { InstanceName } from "../brand/instance-mark";
import { CommandPalette } from "./command-palette";
import { LoadFailed } from "./load-failed";
import { PageInShell } from "./page-crashed";
import { AboutDialog } from "./about-dialog";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Sidebar } from "./sidebar";

/**
 * What administrators tell everyone (ADR 0042): their announcement, and,
 * to the administrators still in, that maintenance is on.
 */
/** Shown on every page while an administrator uses someone else's rights. */
function ActingBanner() {
  const { t } = useLingui();
  const session = useSession();
  const navigate = useNavigate();
  const acting = session.data?.actingAs;
  const [busy, setBusy] = useState(false);
  const when = useWhen();
  if (!acting) return null;
  const until = when.clock(acting.until);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning-surface px-4 py-2 text-sm"
    >
      <span>{t`You are acting as ${acting.displayName} until ${until}.`}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void trpc.admin.stopActing
            .mutate()
            .then(async () => {
              await session.refetch();
              await navigate({ to: "/" });
            })
            .finally(() => setBusy(false));
        }}
      >
        {t`Stop`}
      </Button>
    </div>
  );
}

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
  const pageMain = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    // Closing gives focus back to the button that opened it.
    if (wasOpen.current && navigation === "closed") menuButton.current?.focus();
    wasOpen.current = navigation === "open";
  }, [navigation]);
  // The page asked for, with its search, to come back to after sign-in.
  // The shell is still drawn while the router leaves for /login: there,
  // `here` is the sign-in page itself (`safeNext` makes it "/"), and a
  // second redirect would write that over the page asked for.
  const here = useLocation({ select: (location) => safeNext(location.href) });
  useEffect(() => {
    if (session.isSuccess && !session.data && !onSignIn(page)) {
      void navigate({ to: "/login", search: { next: here }, replace: true });
    }
  }, [session.isSuccess, session.data, navigate, here, page]);
  // The policy asks this account for a second factor before anything else
  // (ADR 0043): the account page is where it is set up.
  const mustEnroll = Boolean(session.data) && !mayRead(session.data);
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
    <RealtimeProvider enabled={!mustEnroll}>
      <JobsProvider>
        <div className="flex h-screen overflow-hidden">
          {/* The keyboard's first stop: past the navigation, which holds
              every base and table, to the page. Drawn once it is reached. */}
          <a
            href="#page"
            className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-card focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
            onClick={(event) => {
              event.preventDefault();
              pageMain.current?.focus();
            }}
          >
            {t`Skip to the content`}
          </a>
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
                  <InstanceName />
                </span>
              </div>
            ) : null}
            <InstanceBanner />
            <ActingBanner />
            <ConnectionBanner />
            <PageInShell value>
              <main
                ref={pageMain}
                id="page"
                tabIndex={-1}
                className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
              >
                {children}
              </main>
            </PageInShell>
          </div>
        </div>
        {mustEnroll ? null : <CommandPalette />}
        <ShortcutsDialog />
        <AboutDialog />
      </JobsProvider>
    </RealtimeProvider>
  );
}
