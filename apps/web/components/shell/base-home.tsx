import { Spinner } from "@anygriddb/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCatalog } from "../../lib/session";
import { canManage } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";

export function BaseHome({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === baseId);
  const first = base?.tables[0];
  useEffect(() => {
    if (first)
      void navigate({
        to: "/b/$baseId/t/$tableId/{-$viewId}",
        params: { baseId: baseId, tableId: first.id },
        replace: true,
      });
  }, [first, navigate, baseId]);
  if (!catalog.data || first) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!base) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This base does not exist or is not shared with you.`}
      </p>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
      <p>
        {canManage(base.role)
          ? t`This base is empty. Add a table from the sidebar.`
          : t`This base has no tables yet.`}
      </p>
    </div>
  );
}
