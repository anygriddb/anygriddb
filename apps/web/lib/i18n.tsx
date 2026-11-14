/**
 * The person's language (ADR 0041). Messages are Lingui catalogs, one per
 * language; English is the source. A language the person picked wins, then
 * the browser's when the app speaks it, then the instance's default.
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

type Locale = "fr" | "en";

const STORAGE_KEY = "ag_locale";

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * The instance's language, used until the person picks one, when their
   * browser asks for none the app speaks.
   */
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

/** The first of the browser's languages the app speaks, if any. */
export function browserLocale(languages: readonly string[]): Locale | null {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag === "fr" || tag.startsWith("fr-")) return "fr";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return null;
}

function navigatorLocale(): Locale | null {
  return browserLocale(
    navigator.languages.length > 0 ? navigator.languages : [navigator.language],
  );
}

/** The picked language, or the browser's, or English. */
export function initialLocale(): Locale {
  return storedLocale() ?? navigatorLocale() ?? "en";
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
  // The instance's default applies only when neither the person nor their
  // browser named a language the app speaks.
  const [settled] = useState(
    () => storedLocale() !== null || navigatorLocale() !== null,
  );
  const chosen = useRef(settled);
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
