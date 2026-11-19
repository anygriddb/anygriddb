import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { TriangleAlert } from "lucide-react";
import { createContext, use } from "react";

/**
 * Whether a page is drawn inside the shell, which holds the page's
 * `main`. Kept here, with what the app loads first: the shell is loaded
 * with the first page behind a session.
 */
export const PageInShell = createContext(false);

/**
 * What a page shows when its code fails while drawing: in the person's
 * language, without the error's text, and with a way out. The router
 * puts it in place of the page alone, so the sidebar stays, and draws the
 * page again once the person goes elsewhere. The boundary around the whole
 * app shows it too, outside the router: the way home is a plain link.
 */
export function PageCrashed({ onReload }: { onReload?: () => void } = {}) {
  const { t } = useLingui();
  // In the shell it takes a page's place in the shell's `main`; outside,
  // it is the page, and its landmark.
  const Frame = use(PageInShell) ? "div" : "main";
  return (
    <Frame className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <TriangleAlert className="h-6 w-6 text-danger" aria-hidden />
      {/* Announced as it appears; `main` stays the page's landmark. */}
      <div role="alert" className="flex flex-col items-center gap-3">
        <h1 className="text-lg font-semibold">{t`This page stopped working`}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t`What you saved is kept. Reload the page to carry on.`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            if (onReload) onReload();
            else window.location.reload();
          }}
        >
          {t`Reload the page`}
        </Button>
        <a
          href="/"
          className="inline-flex items-center px-2 text-sm text-primary underline"
        >
          {t`Back to home`}
        </a>
      </div>
    </Frame>
  );
}
