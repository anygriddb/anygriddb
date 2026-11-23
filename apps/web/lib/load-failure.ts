/**
 * What the page shows when its words could not be loaded: the language
 * catalog is a file of its own, and the network may fail on it. There is
 * then no catalog to translate with, so these two sentences live here, in
 * both languages. Everything else the app says goes through Lingui.
 */
const WORDS = {
  en: {
    text: "AnyGridDB could not be loaded. Check your connection, then reload the page.",
    action: "Reload the page",
  },
  fr: {
    text: "AnyGridDB n’a pas pu être chargé. Vérifiez votre connexion, puis rechargez la page.",
    action: "Recharger la page",
  },
} as const;

/** The little of a document this needs: a test hands a stand-in. */
type Page = Pick<Document, "createElement">;

/** Puts the message and a way to reload in place of the empty page. */
export function showLoadFailure(
  root: Pick<HTMLElement, "replaceChildren">,
  locale: keyof typeof WORDS,
  reload: () => void = () => {
    window.location.reload();
  },
  page: Page = document,
): void {
  const words = WORDS[locale];
  const box = page.createElement("div");
  box.setAttribute("role", "alert");
  box.className =
    "flex h-screen flex-col items-center justify-center gap-3 p-6 text-center";
  const text = page.createElement("p");
  text.className = "max-w-md text-sm";
  text.textContent = words.text;
  const button = page.createElement("button");
  button.type = "button";
  button.className =
    "rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted";
  button.textContent = words.action;
  button.addEventListener("click", reload);
  box.append(text, button);
  root.replaceChildren(box);
}

/**
 * What to do when a piece of the app fails to load. A tab opened before an
 * update asks for files the new build no longer has: it is reloaded, once,
 * to get the new page (`reload`), and never in a loop (`leave`). With no
 * network a reload would put the browser's own error page in place of the
 * app, and what the screen held would be lost: the app's fallback says what
 * failed, and the page is reloaded when the network is back (`wait`).
 */
export function afterFailedLoad(input: {
  online: boolean;
  /** When this tab last reloaded itself for an update, or 0. */
  reloadedAt: number;
  now: number;
}): "reload" | "wait" | "leave" {
  if (!input.online) return "wait";
  return input.now - input.reloadedAt < 30_000 ? "leave" : "reload";
}
