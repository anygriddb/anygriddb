import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { activateLocale, initialLocale } from "../lib/i18n";
import { afterFailedLoad, showLoadFailure } from "../lib/load-failure";
import { reportFailure, reportUncaught } from "../lib/report-failure";
import { Providers } from "./providers";
import { router } from "./router";
import "./globals.css";

// A piece of the app that fails to load: a tab opened before an update is
// reloaded once to get the new page, and a tab with no network waits for it
// (`afterFailedLoad`).
let waitingForNetwork = false;
window.addEventListener("vite:preloadError", (event) => {
  const key = "ag_reloaded_for_update";
  let reloadedAt: number;
  try {
    reloadedAt = Number(window.sessionStorage.getItem(key) ?? 0);
  } catch {
    return;
  }
  const next = afterFailedLoad({
    online: window.navigator.onLine,
    reloadedAt,
    now: Date.now(),
  });
  if (next === "leave") return;
  if (next === "wait") {
    // The failure is left to the app's own fallback, which says it.
    if (waitingForNetwork) return;
    waitingForNetwork = true;
    window.addEventListener(
      "online",
      () => {
        window.location.reload();
      },
      { once: true },
    );
    return;
  }
  try {
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root");
if (!root) throw new Error("The page has no root element");

reportUncaught();

// The first render already speaks the person's language. Without its
// words there is nothing to draw: say so, rather than leave a blank page.
try {
  await activateLocale(initialLocale());
} catch (error) {
  showLoadFailure(root, initialLocale());
  reportFailure("error", error);
  throw error;
}

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
