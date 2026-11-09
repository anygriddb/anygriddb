import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemeChoice = "light" | "dark" | "system";

const ThemeContext = createContext<{
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
}>({
  theme: "system",
  setTheme: () => undefined,
});

function readStored(): ThemeChoice {
  try {
    const value = window.localStorage.getItem("ag_theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: ThemeChoice): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readStored);
  useEffect(() => {
    apply(readStored());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => apply(readStored());
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    try {
      window.localStorage.setItem("ag_theme", next);
    } catch {
      // Storage can be blocked; the choice still applies to this page.
    }
    apply(next);
  }, []);
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
