import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

/**
 * What a page shows when its code fails while drawing: in the person's
 * language, without the error's text, and with a way out. The router
 * puts it in place of the page alone, so the sidebar stays, and draws the
 * page again once the person goes elsewhere.
 */
export function PageCrashed() {
  const { t } = useLingui();
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <TriangleAlert className="h-6 w-6 text-destructive" aria-hidden />
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
            window.location.reload();
          }}
        >
          {t`Reload the page`}
        </Button>
        <Link
          to="/"
          className="inline-flex items-center px-2 text-sm text-primary underline"
        >
          {t`Back to home`}
        </Link>
      </div>
    </main>
  );
}
