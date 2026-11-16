import { cn, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { trpc, useTRPC } from "../../lib/trpc";
import { InstanceMark } from "../brand/instance-mark";
import { PublicRows, readProof, ShareLocked } from "./public-view";

/**
 * A whole base shared read-only by one link (ROADMAP row 93): each table
 * its creator reads, one at a time, with the fields they see. Nothing is
 * written, copied, or downloaded from here.
 */
export function PublicBase({ token }: { token: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  // An access proof outlives a reload of the tab, not the tab itself.
  const proofKey = `ag_share_${token.slice(0, 12)}`;
  const [granted, setGranted] = useState(() => readProof(proofKey));
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const [tableId, setTableId] = useState<string | null>(null);
  const opened = useQuery({
    ...api.share.openBase.queryOptions({ token, access: granted }),
    retry: false,
  });
  const access = granted ?? opened.data?.access ?? undefined;
  useEffect(() => {
    if (!access) return;
    try {
      window.sessionStorage.setItem(proofKey, access);
    } catch {
      // The access proof then lasts for this page only.
    }
  }, [access, proofKey]);

  async function unlock() {
    setChecking(true);
    try {
      const result = await trpc.share.unlockBase.mutate({ token, password });
      setWrong(result.locked);
      if (!result.locked) setGranted(result.access ?? undefined);
    } catch {
      setWrong(true);
    } finally {
      setChecking(false);
    }
  }

  if (opened.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (opened.isError || !opened.data) {
    return (
      <p className="p-10 text-center text-muted-foreground">
        {t`This link does not exist, has expired, or was revoked.`}
      </p>
    );
  }
  const data = opened.data;
  if (data.locked) {
    return (
      <ShareLocked
        password={password}
        onPassword={setPassword}
        wrong={wrong}
        checking={checking}
        onSubmit={() => void unlock()}
      />
    );
  }
  const table =
    data.tables.find((item) => item.id === tableId) ?? data.tables[0];
  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-col gap-2 border-b border-border bg-card px-4 pt-3">
        <div className="flex items-center gap-2">
          <InstanceMark className="h-6 w-6" named />
          <h1 className="truncate font-semibold">{data.base.name}</h1>
        </div>
        <nav
          aria-label={t`Tables`}
          className="flex min-w-0 gap-3 overflow-x-auto"
        >
          {data.tables.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === table?.id ? "page" : undefined}
              onClick={() => setTableId(item.id)}
              className={cn(
                "shrink-0 border-b-2 px-0.5 py-2 text-sm",
                item.id === table?.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.name}
            </button>
          ))}
        </nav>
      </header>
      {table ? (
        <PublicRows
          key={table.id}
          token={token}
          access={access}
          tableId={table.id}
          columns={table.columns}
          allowCopy={false}
          cards={false}
        />
      ) : (
        <p className="p-10 text-center text-muted-foreground">
          {t`This base has no table to show.`}
        </p>
      )}
    </main>
  );
}
