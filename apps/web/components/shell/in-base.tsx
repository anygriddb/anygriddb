import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useCatalog } from "../../lib/session";
import { LoadFailed } from "./load-failed";

/**
 * A page of a base, drawn once the reader's catalog holds that base. One
 * that does not exist, or is not shared with them, is said so on every
 * page it has, and nothing is asked of the server about it: a page that
 * asked first was refused, and stayed blank or offered to try again.
 */
export function InBase({
  baseId,
  children,
}: {
  baseId: string;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const catalog = useCatalog();
  if (!catalog.data) {
    if (catalog.isError) {
      return (
        <LoadFailed
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!catalog.data.some((base) => base.id === baseId)) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This base does not exist or is not shared with you.`}
      </p>
    );
  }
  return children;
}
