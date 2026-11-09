import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

export function NotFound() {
  const { t } = useLingui();
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3">
      <h1 className="text-lg font-semibold">{t`Page not found`}</h1>
      <Link to="/" className="text-primary underline">
        {t`Back to home`}
      </Link>
    </main>
  );
}
