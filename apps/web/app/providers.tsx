import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { AriaLocaleProvider, UiTextProvider } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Toaster } from "sonner";
import { useInstanceIdentity } from "../components/brand/instance-mark";
import { ErrorBoundary } from "../components/shell/error-boundary";
import { I18nProvider, useLocale } from "../lib/i18n";
import { ThemeProvider, useTheme } from "../lib/theme";
import { createClient, TRPCProvider, useTRPC } from "../lib/trpc";

/**
 * The words the shared components say, in the person's language: ours,
 * and React Aria's own (a calendar's buttons, a list's name), which also
 * write dates and numbers as that language does.
 */
function UiTexts({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  return (
    <AriaLocaleProvider locale={locale === "fr" ? "fr-FR" : "en-GB"}>
      <UiTextProvider close={t`Close`} loading={t`Loading`}>
        {children}
      </UiTextProvider>
    </AriaLocaleProvider>
  );
}

/** Applies the instance's default language until the person picks one. */
function InstanceLocale() {
  const api = useTRPC();
  const { adoptDefault } = useLocale();
  const instance = useQuery({
    ...api.auth.instance.queryOptions(),
    staleTime: 5 * 60_000,
  });
  const fallback = instance.data?.defaultLocale;
  useEffect(() => {
    if (fallback) adoptDefault(fallback);
  }, [fallback, adoptDefault]);
  return null;
}

/** The browser's tab carries the instance's name (ADR 0072). */
function InstanceTitle() {
  const { name } = useInstanceIdentity();
  useEffect(() => {
    document.title = name;
  }, [name]);
  return null;
}

/** Toasts in the app's theme, which may differ from the system's. */
function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster richColors closeButton position="bottom-right" theme={theme} />
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  const [trpcClient] = useState(() => createClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <ThemeProvider>
          <I18nProvider>
            <ErrorBoundary>
              <InstanceLocale />
              <InstanceTitle />
              <UiTexts>{children}</UiTexts>
              <ThemedToaster />
            </ErrorBoundary>
          </I18nProvider>
        </ThemeProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
