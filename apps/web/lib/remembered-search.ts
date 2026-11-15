import { useEffect, useMemo, useRef } from "react";

/** A store the page can do without: a private window may refuse it. */
export type SearchMemory = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** The browser's session store, or a store that forgets when it refuses. */
function browserSession(): SearchMemory {
  return {
    getItem(key) {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      sessionStorage.setItem(key, value);
    },
    removeItem(key) {
      sessionStorage.removeItem(key);
    },
  };
}

/**
 * Remembers a page's address for the tab. A value the schema drops is
 * dropped here too. An empty address clears the memory.
 */
export function rememberSearch<T extends object>(
  key: string,
  parse: (value: unknown) => T,
  memory: SearchMemory,
) {
  return {
    read(): T {
      try {
        const raw = memory.getItem(key);
        if (!raw) return parse({});
        return parse(JSON.parse(raw) as unknown);
      } catch {
        return parse({});
      }
    },
    write(value: T) {
      try {
        if (Object.keys(value).length === 0) memory.removeItem(key);
        else memory.setItem(key, JSON.stringify(value));
      } catch {
        // The address still holds the choice.
      }
    },
  };
}

/**
 * The address wins, and is what the tab remembers. A bare address takes
 * the memory back, and asks the address to show it.
 */
export function visitSearch<T extends object>(
  url: T,
  read: () => T,
  write: (value: T) => void,
): { search: T; replaceUrl: T | null } {
  if (Object.keys(url).length > 0) {
    write(url);
    return { search: url, replaceUrl: null };
  }
  const stored = read();
  if (Object.keys(stored).length > 0) {
    return { search: stored, replaceUrl: stored };
  }
  return { search: url, replaceUrl: null };
}

/**
 * The filters a page shows. A link with parameters opens as written. A
 * bare address opens what this tab last chose. Clearing the filters
 * (navigating to a bare address after the page had parameters) drops
 * the memory: it must not put the old choice back.
 */
export function useRememberedSearch<T extends object>(
  key: string,
  parse: (value: unknown) => T,
  url: T,
  navigate: (next: T) => void,
): T {
  const store = useMemo(
    () => rememberSearch(key, parse, browserSession()),
    [key, parse],
  );
  const serial = JSON.stringify(url);
  const bare = Object.keys(url).length === 0;
  /** Null until this mount has synced once; then the last address serial. */
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!bare) {
      store.write(url);
      sent.current = serial;
      return;
    }
    if (sent.current === null) {
      const stored = store.read();
      const next = JSON.stringify(stored);
      if (next !== "{}") {
        sent.current = next;
        navigate(stored);
      } else {
        sent.current = "{}";
      }
      return;
    }
    // Bare after we had parameters: the reader cleared the filters.
    store.write({} as T);
    sent.current = "{}";
  }, [bare, navigate, serial, store, url]);
  if (!bare) return url;
  if (sent.current === null) {
    const stored = store.read();
    return Object.keys(stored).length > 0 ? stored : url;
  }
  return url;
}
