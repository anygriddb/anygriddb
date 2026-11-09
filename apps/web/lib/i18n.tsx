/**
 * The person's language (ADR 0041). Messages are Lingui catalogs, one per
 * language; English is the source. A language the person picked wins over
 * the instance's default.
 */
import { i18n } from "@lingui/core";
import { I18nProvider as LinguiProvider } from "@lingui/react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Locale = "fr" | "en";

const STORAGE_KEY = "ag_locale";

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** The instance's language, used until the person picks one. */
  adoptDefault: (locale: Locale) => void;
}>({
  locale: "en",
  setLocale: () => undefined,
  adoptDefault: () => undefined,
});

/** The language the person picked, if any. */
function storedLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "en" || stored === "fr" ? stored : null;
  } catch {
    return null;
  }
}

/** The picked language, or the browser's. */
export function initialLocale(): Locale {
  return (
    storedLocale() ??
    (navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en")
  );
}

/** Loads a language's catalog and switches every message to it. */
export async function activateLocale(locale: Locale): Promise<void> {
  if (i18n.locale === locale) return;
  const { messages } = (await import(`../locales/${locale}/messages.po`)) as {
    messages: Record<string, string>;
  };
  i18n.loadAndActivate({ locale, messages });
  document.documentElement.lang = locale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    i18n.locale === "fr" ? "fr" : "en",
  );
  const [picked] = useState(() => storedLocale() !== null);
  const chosen = useRef(picked);
  const change = useCallback(async (next: Locale) => {
    await activateLocale(next);
    setLocaleState(next);
  }, []);
  const adoptDefault = useCallback(
    (next: Locale) => {
      if (!chosen.current) void change(next);
    },
    [change],
  );
  const setLocale = useCallback(
    (next: Locale) => {
      chosen.current = true;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The choice still applies to this page.
      }
      void change(next);
    },
    [change],
  );
  return (
    <LocaleContext value={{ locale, setLocale, adoptDefault }}>
      <LinguiProvider i18n={i18n}>{children}</LinguiProvider>
    </LocaleContext>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
