import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { activateLocale, initialLocale } from "../lib/i18n";
import { Providers } from "./providers";
import { router } from "./router";
import "./globals.css";

// A tab opened before a deploy asks for files the new build no longer has:
// reload it once to get the new page, but never in a loop.
window.addEventListener("vite:preloadError", (event) => {
  const key = "ag_reloaded_for_update";
  try {
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 30_000) return;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root");
if (!root) throw new Error("The page has no root element");

// The first render already speaks the person's language.
await activateLocale(initialLocale());

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
