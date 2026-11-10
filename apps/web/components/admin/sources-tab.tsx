/**
 * Client databases (ADR 0026). An administrator declares a source with a
 * dedicated account; it is saved only once a connection succeeds, over
 * verified TLS. The password is written, never shown again.
 */
import {
  DEFAULT_SOURCE_PORTS,
  type SourceEngine,
  type SourceInput,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Plus, RefreshCw, ShieldAlert, Table2 } from "lucide-react";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { raw } from "../../lib/known-text";
import { FIELD_LABELS } from "../fields/field-meta";
import { ConfirmDialog } from "../shell/dialogs";
import { RefreshFields } from "./refresh-fields";

type Source = RouterOutputs["admin"]["sources"]["list"][number];
type SourceTableItem = RouterOutputs["admin"]["sources"]["tables"][number];
type Exposure = SourceTableItem["exposedIn"][number];
type Right = keyof Exposure["writes"];

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

const ENGINES: Array<[SourceEngine, string, boolean]> = [
  ["postgres", "PostgreSQL", true],
  ["mysql", "MySQL", true],
  ["mariadb", "MariaDB", true],
  ["sqlserver", "SQL Server", true],
];

export function SourcesTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.sources.settings.queryOptions());
  const list = useQuery(api.admin.sources.list.queryOptions());
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [browsing, setBrowsing] = useState<Source | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.sources.list.queryKey(),
    });

  async function check(source: Source) {
    try {
      const result = await trpc.admin.sources.check.mutate({ id: source.id });
      toast.success(
        result.replicaServerVersion
          ? t`${{ name: source.name }} answers (primary ${{ version: result.serverVersion }}, replica ${{ replica: result.replicaServerVersion }})`
          : t`${{ name: source.name }} answers (version ${{ version: result.serverVersion }})`,
      );
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const allowed = settings.data?.allowedHosts ?? [];
  return (
    <div className="flex flex-col gap-3">
      {settings.data?.allowPlaintext ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-sm"
        >
          <ShieldAlert className="h-4 w-4 text-danger" aria-hidden />
          {t`ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT is on: sources connect without TLS. For development only.`}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {allowed.length > 0
          ? t`Allowed hosts: ${{ hosts: allowed.join(", ") }}`
          : t`No host is allowed: the operator sets ANYGRIDDB_SOURCES_ALLOWED_HOSTS.`}
      </p>
      <div>
        <Button
          size="sm"
          disabled={allowed.length === 0}
          onClick={() => setEditing("new")}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Declare a source`}
        </Button>
      </div>
      {list.isLoading ? <Spinner /> : null}
      {list.data && list.data.length > 0 ? (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t`Name`}</th>
                <th className="px-3 py-2">{t`Address`}</th>
                <th className="px-3 py-2">{t`Account`}</th>
                <th className="px-3 py-2">{t`Side schema`}</th>
                <th className="px-3 py-2">{t`Version`}</th>
                <th className="px-3 py-2">{t`Replica`}</th>
                <th className="px-3 py-2">{t`Checked`}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((source) => (
                <tr key={source.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      <Database className="h-4 w-4 text-primary" aria-hidden />
                      {source.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {source.host}:{source.port}/{source.database}
                  </td>
                  <td className="px-3 py-2">{source.username}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {source.sideSchema ? (
                      source.sideSchema
                    ) : (
                      <span className="text-muted-foreground">{t`Not set`}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{source.serverVersion ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {source.replicaHost ? (
                      <span className="font-mono">
                        {source.replicaHost}:{source.replicaPort}/
                        {source.replicaDatabase ?? source.database}
                        {source.replicaServerVersion
                          ? ` · ${source.replicaServerVersion}`
                          : ""}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t`None`}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {source.checkedAt
                      ? new Date(source.checkedAt).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void check(source)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        {t`Verify`}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setBrowsing(source)}
                      >
                        {t`Tables`}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditing(source)}
                      >
                        {t`Edit`}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-danger"
                        onClick={() => setRemoving(source)}
                      >
                        {t`Delete`}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <SourceDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void refresh()}
      />
      <Dialog
        open={browsing !== null}
        onOpenChange={(open) => !open && setBrowsing(null)}
      >
        <DialogContent
          title={t`Tables of ${{ name: browsing?.name ?? "" }}`}
          description={t`What the source's account may read, and how each column will show. Tick the tables to show in a base: their rows stay with the client.`}
          wide
        >
          {browsing ? <SourceTables source={browsing} /> : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        danger
        title={t`Delete the source ${{ name: removing?.name ?? "" }}?`}
        description={t`AnyGridDB forgets this source and its password. The client's database is not touched.`}
        confirmLabel={t`Delete`}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await trpc.admin.sources.delete.mutate({ id: removing.id });
            setRemoving(null);
            await refresh();
          } catch (cause) {
            toast.error(errorText(cause));
          }
        }}
      />
    </div>
  );
}

function SourceDialog(props: {
  target: Source | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent
        title={
          props.target === "new" ? t`Declare a source` : t`Edit the source`
        }
        description={t`An account dedicated to AnyGridDB, never an administrator. The connection uses TLS, with a verified certificate.`}
        wide
      >
        {/* Mounted while open only: each opening starts from the source. */}
        {props.target ? (
          <SourceForm
            source={props.target === "new" ? undefined : props.target}
            onClose={props.onClose}
            onSaved={props.onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SourceForm(props: {
  source: Source | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const existing = props.source;
  const [engine, setEngine] = useState<SourceEngine>(
    existing?.engine ?? "postgres",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(
    String(existing?.port ?? DEFAULT_SOURCE_PORTS.postgres),
  );
  const [database, setDatabase] = useState(existing?.database ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [password, setPassword] = useState("");
  const [certificate, setCertificate] = useState(existing?.tlsCa ?? "");
  const [timeout, setTimeoutSeconds] = useState(
    String((existing?.queryTimeoutMs ?? 15_000) / 1000),
  );
  const [limit, setLimit] = useState(String(existing?.connectionLimit ?? 5));
  const [timeZone, setTimeZone] = useState(existing?.timeZone ?? "UTC");
  const [sideSchema, setSideSchema] = useState(existing?.sideSchema ?? "");
  const [replicaHost, setReplicaHost] = useState(existing?.replicaHost ?? "");
  const [replicaPort, setReplicaPort] = useState(
    existing?.replicaPort != null ? String(existing.replicaPort) : "",
  );
  const [replicaDatabase, setReplicaDatabase] = useState(
    existing?.replicaDatabase ?? "",
  );
  const [replicaUsername, setReplicaUsername] = useState(
    existing?.replicaUsername ?? "",
  );
  const [replicaPassword, setReplicaPassword] = useState("");
  const [busy, setBusy] = useState(false);

  function input(): SourceInput {
    const primaryPort = Number(port);
    const replica = replicaHost.trim();
    return {
      name: name.trim(),
      engine,
      host: host.trim(),
      port: primaryPort,
      database: database.trim(),
      username: username.trim(),
      password,
      tlsCa: certificate.trim() || null,
      connectionLimit: Number(limit),
      queryTimeoutMs: Math.round(Number(timeout) * 1000),
      timeZone: timeZone.trim() || "UTC",
      sideSchema: sideSchema.trim() || null,
      replicaHost: replica || null,
      replicaPort: replica
        ? replicaPort.trim()
          ? Number(replicaPort)
          : primaryPort
        : null,
      replicaDatabase: replicaDatabase.trim() || null,
      replicaUsername: replicaUsername.trim() || null,
      replicaPassword: replicaPassword || null,
    };
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    await run(async () => {
      if (existing && !password) {
        const result = await trpc.admin.sources.check.mutate({
          id: existing.id,
        });
        toast.success(
          result.replicaServerVersion
            ? t`Connected (primary ${{ version: result.serverVersion }}, replica ${{ replica: result.replicaServerVersion }})`
            : t`Connected (version ${{ version: result.serverVersion }})`,
        );
        return;
      }
      const result = await trpc.admin.sources.test.mutate(input());
      toast.success(
        result.replicaServerVersion
          ? t`Connected (primary ${{ version: result.serverVersion }}, replica ${{ replica: result.replicaServerVersion }})`
          : t`Connected (version ${{ version: result.serverVersion }})`,
      );
    });
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      if (existing) {
        const next = input();
        await trpc.admin.sources.update.mutate({
          id: existing.id,
          name: next.name,
          engine: next.engine,
          host: next.host,
          port: next.port,
          database: next.database,
          username: next.username,
          tlsCa: next.tlsCa,
          connectionLimit: next.connectionLimit,
          queryTimeoutMs: next.queryTimeoutMs,
          timeZone: next.timeZone,
          sideSchema: next.sideSchema,
          replicaHost: next.replicaHost,
          replicaPort: next.replicaPort,
          replicaDatabase: next.replicaDatabase,
          replicaUsername: next.replicaUsername,
          ...(password ? { password } : {}),
          ...(replicaPassword ? { replicaPassword } : {}),
        });
      } else {
        await trpc.admin.sources.create.mutate(input());
      }
      toast.success(t`Source saved`);
      props.onSaved();
      props.onClose();
    });
  }

  const complete =
    name.trim() &&
    host.trim() &&
    database.trim() &&
    username.trim() &&
    (password || existing);
  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-3">
      <div className="col-span-2 flex flex-col gap-1">
        <Label htmlFor="source-name">{t`Name`}</Label>
        <Input
          id="source-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-engine">{t`Engine`}</Label>
        <Select
          id="source-engine"
          value={engine}
          onChange={(event) => {
            const next = event.target.value as SourceEngine;
            setEngine(next);
            setPort(String(DEFAULT_SOURCE_PORTS[next]));
          }}
        >
          {ENGINES.map(([value, label, ready]) => (
            <option key={value} value={value} disabled={!ready}>
              {ready ? label : t`${{ engine: label }} (soon)`}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-database">{t`Database`}</Label>
        <Input
          id="source-database"
          value={database}
          onChange={(event) => setDatabase(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-host">{t`Host`}</Label>
        <Input
          id="source-host"
          placeholder="db.internal"
          value={host}
          onChange={(event) => setHost(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-port">{t`Port`}</Label>
        <Input
          id="source-port"
          inputMode="numeric"
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-username">{t`Account`}</Label>
        <Input
          id="source-username"
          autoComplete="off"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-password">{t`Password`}</Label>
        <Input
          id="source-password"
          type="password"
          autoComplete="new-password"
          placeholder={existing ? t`Unchanged` : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div className="col-span-2 flex flex-col gap-1">
        <Label htmlFor="source-certificate">{t`Certificate (optional)`}</Label>
        <Textarea
          id="source-certificate"
          aria-describedby="source-certificate-help"
          className="min-h-24 font-mono text-xs"
          placeholder="-----BEGIN CERTIFICATE-----"
          value={certificate}
          onChange={(event) => setCertificate(event.target.value)}
        />
        <p
          id="source-certificate-help"
          className="text-xs text-muted-foreground"
        >
          {t`The server's internal certificate authority, or its self-signed certificate. Without one, the system's authorities are trusted.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-timeout">{t`Time limit per query (seconds)`}</Label>
        <Input
          id="source-timeout"
          inputMode="numeric"
          value={timeout}
          onChange={(event) => setTimeoutSeconds(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-limit">{t`Connections at most`}</Label>
        <Input
          id="source-limit"
          inputMode="numeric"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </div>
      <div className="col-span-2 flex flex-col gap-1">
        <Label htmlFor="source-time-zone">{t`Time zone`}</Label>
        <Input
          id="source-time-zone"
          list="source-time-zones"
          aria-describedby="source-time-zone-help"
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
        />
        <datalist id="source-time-zones">
          {TIME_ZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p id="source-time-zone-help" className="text-xs text-muted-foreground">
          {t`The zone of the dates and times the database stores without one.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-side-schema">{t`Schema kept for AnyGridDB (optional)`}</Label>
        <Input
          id="source-side-schema"
          value={sideSchema}
          placeholder="anygriddb"
          aria-describedby="source-side-schema-help"
          onChange={(event) => setSideSchema(event.target.value)}
        />
        <p
          id="source-side-schema-help"
          className="text-xs text-muted-foreground"
        >
          {t`Fields people add to this source's tables are kept there, one side table per exposed table (a database on MySQL and MariaDB). Left empty, AnyGridDB keeps them in its own database: they filter a view, but cannot sort or group it. The client's tables are never changed.`}
        </p>
      </div>
      <div className="col-span-2 flex flex-col gap-1">
        <Label htmlFor="source-replica-host">{t`Read replica host (optional)`}</Label>
        <div className="grid grid-cols-[1fr_6rem_1fr] gap-2">
          <Input
            id="source-replica-host"
            value={replicaHost}
            placeholder={t`Same as primary when empty`}
            onChange={(event) => setReplicaHost(event.target.value)}
          />
          <Input
            aria-label={t`Replica port`}
            value={replicaPort}
            placeholder={port}
            onChange={(event) => setReplicaPort(event.target.value)}
          />
          <Input
            aria-label={t`Replica database`}
            value={replicaDatabase}
            placeholder={database || t`Database`}
            onChange={(event) => setReplicaDatabase(event.target.value)}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            aria-label={t`Replica username`}
            value={replicaUsername}
            placeholder={username || t`Username`}
            onChange={(event) => setReplicaUsername(event.target.value)}
          />
          <Input
            type="password"
            aria-label={t`Replica password`}
            value={replicaPassword}
            placeholder={
              existing?.replicaHost
                ? t`Leave blank to keep the stored password`
                : t`Same as primary when empty`
            }
            onChange={(event) => setReplicaPassword(event.target.value)}
            autoComplete="new-password"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t`Grid and API reads use the replica when set; writes stay on the primary. If the replica is unreachable, reads fall back to the primary.`}
        </p>
      </div>
      <DialogFooter className="col-span-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t`Cancel`}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !complete}
          onClick={() => void test()}
        >
          {t`Test the connection`}
        </Button>
        <Button type="submit" disabled={busy || !complete}>
          {busy ? <Spinner /> : null}
          {t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What the source's account may read, as introspection found it. */
function SourceTables(props: { source: Source }) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const tables = useQuery({
    ...api.admin.sources.tables.queryOptions({ id: props.source.id }),
    retry: false,
  });
  // Where each exposed table stands, read again while a copy or a first
  // check is under way: the source itself is not asked again.
  const exposures = useQuery({
    ...api.admin.sources.exposures.queryOptions({ id: props.source.id }),
    refetchInterval: (query) =>
      Object.values(query.state.data ?? {}).some((items) =>
        items.some(
          (item) =>
            (item.sync !== null &&
              item.sync.syncedAt === null &&
              item.sync.errorCode === null) ||
            (item.watch !== null && item.watch.checkedAt === null),
        ),
      )
        ? 2_000
        : 15_000,
  });
  // The bases the administrator works in: exposed tables show there.
  const bases = useQuery(api.catalog.list.queryOptions());
  const [baseId, setBaseId] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (tables.isLoading) return <Spinner />;
  if (tables.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {errorText(tables.error)}
      </p>
    );
  }
  const list = tables.data ?? [];
  if (list.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t`The account may read no table: grant it SELECT on the tables to expose.`}
      </p>
    );
  }
  const owned = (bases.data ?? []).filter((base) => base.role === "owner");
  // Until one is picked: the base this source's tables already show in.
  const exposedBase = list
    .flatMap((table) => table.exposedIn)
    .find((item) => owned.some((base) => base.id === item.baseId))?.baseId;
  const target =
    owned.find((base) => base.id === (baseId || exposedBase)) ?? owned[0];
  const keyOf = (table: { schema: string; name: string }) =>
    `${table.schema}.${table.name}`;
  const exposureIn = (table: SourceTableItem) =>
    target === undefined
      ? undefined
      : (exposures.data?.[keyOf(table)] ?? table.exposedIn).find(
          (item) => item.baseId === target.id,
        );
  const picked = list.filter(
    (table) =>
      chosen.has(keyOf(table)) && target !== undefined && !exposureIn(table),
  );
  const number = new Intl.NumberFormat(i18n.locale);

  async function expose() {
    if (!target || picked.length === 0) return;
    setBusy(true);
    try {
      const result = await trpc.admin.sources.expose.mutate({
        sourceId: props.source.id,
        baseId: target.id,
        tables: picked.map((table) => ({
          schema: table.schema,
          name: table.name,
        })),
      });
      toast.success(
        plural(
          { count: result.tableIds.length },
          {
            one: `# table added to ${ph({ base: target.name })}`,
            other: `# tables added to ${ph({ base: target.name })}`,
          },
        ),
      );
      setChosen(new Set());
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: api.admin.sources.tables.queryKey({ id: props.source.id }),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.list.queryKey(),
        }),
      ]);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {list.map((table) => {
          const rights = [
            t`read`,
            ...(table.privileges.insert ? [t`insert`] : []),
            ...(table.privileges.update ? [t`update`] : []),
            ...(table.privileges.delete ? [t`delete`] : []),
          ];
          const name = keyOf(table);
          const exposure = exposureIn(table);
          const already = exposure !== undefined;
          return (
            <li
              key={name}
              className="flex flex-wrap items-start gap-x-2 rounded-md border border-border pl-3"
            >
              <Checkbox
                className="mt-2.5 shrink-0"
                aria-label={t`Expose ${{ table: name }}`}
                disabled={already || target === undefined}
                checked={already || chosen.has(name)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(name);
                  else next.delete(name);
                  setChosen(next);
                }}
              />
              <details className="min-w-0 flex-1">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-3 text-sm">
                  <span className="font-mono font-medium">{name}</span>
                  <span className="text-xs text-muted-foreground">
                    {table.kind === "view" ? t`view` : t`table`}
                    {table.estimatedRows !== null
                      ? ` · ${t`~${{ rows: number.format(table.estimatedRows) }} rows`}`
                      : ""}
                    {" · "}
                    {table.primaryKey.length > 0
                      ? t`key ${{ key: table.primaryKey.join(", ") }}`
                      : t`no primary key: read-only`}
                    {" · "}
                    {rights.join(", ")}
                    {already ? ` · ${t`already in this base`}` : ""}
                  </span>
                </summary>
                <table className="w-full border-t border-border text-xs">
                  <thead className="bg-muted text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1">{t`Column`}</th>
                      <th className="px-3 py-1">{t`Source type`}</th>
                      <th className="px-3 py-1">{t`Field`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map((column) => (
                      <tr key={column.name} className="border-t border-border">
                        <td className="px-3 py-1 font-mono">{column.name}</td>
                        <td className="px-3 py-1 font-mono text-muted-foreground">
                          {column.type}
                        </td>
                        <td className="px-3 py-1">
                          {t(
                            FIELD_LABELS[column.field.fieldType] ??
                              raw(column.field.fieldType),
                          )}
                          {column.field.readOnly ? ` · ${t`read-only`}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              {exposure ? (
                <TableWrites
                  table={table}
                  exposure={exposure}
                  sourceId={props.source.id}
                />
              ) : null}
              {exposure ? (
                <div className="basis-full pr-3 pb-2">
                  <RefreshFields tableId={exposure.tableId} />
                </div>
              ) : null}
              {exposure ? (
                <TableSync
                  exposure={exposure}
                  sourceId={props.source.id}
                  changeColumns={table.watchColumns}
                />
              ) : null}
              {exposure && !exposure.sync && table.primaryKey.length > 0 ? (
                <TableWatch
                  table={table}
                  exposure={exposure}
                  sourceId={props.source.id}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`Create a base first: exposed tables show there.`}
        </p>
      ) : (
        <DialogFooter>
          <div className="flex flex-1 items-center gap-2">
            <Label htmlFor="expose-base">{t`Base`}</Label>
            <Select
              id="expose-base"
              value={target?.id ?? ""}
              onChange={(event) => setBaseId(event.target.value)}
            >
              {owned.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            disabled={busy || picked.length === 0}
            onClick={() => void expose()}
          >
            {busy ? <Spinner /> : <Table2 className="h-4 w-4" aria-hidden />}
            {plural(
              { count: picked.length },
              { one: `Expose # table`, other: `Expose # tables` },
            )}
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

/**
 * The writes an administrator enables on an exposed table (ADR 0006):
 * editing, adding, and deleting rows apart, within the account's rights.
 */
function TableWrites(props: {
  table: SourceTableItem;
  exposure: Exposure;
  sourceId: string;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The switch moves at once; it goes back if the server refuses.
  const [pending, setPending] = useState<Partial<Exposure["writes"]>>({});
  // A box is disabled while its change saves, which drops the focus: it
  // goes back to the box once saved, for people on the keyboard.
  const boxes = useRef(new Map<Right, HTMLInputElement>());
  const [last, setLast] = useState<Right | null>(null);
  useEffect(() => {
    if (busy || !last) return;
    const box = boxes.current.get(last);
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      active.getAttribute("role") === "dialog";
    if (box && !box.disabled && lost) box.focus();
  }, [busy, last]);
  const { table, exposure } = props;
  const writes = { ...exposure.writes, ...pending };
  if (table.primaryKey.length === 0) {
    return (
      <p className="basis-full pb-2 text-xs text-muted-foreground">
        {t`Without a primary key, this table stays read-only.`}
      </p>
    );
  }
  const rights: Array<{ key: Right; label: string; grant: string }> = [
    { key: "update", label: t`Edit rows`, grant: "UPDATE" },
    { key: "insert", label: t`Add rows`, grant: "INSERT" },
    { key: "delete", label: t`Delete rows`, grant: "DELETE" },
  ];
  const missing = rights
    .filter((right) => !table.privileges[right.key])
    .map((right) => right.grant);

  async function toggle(key: Right, value: boolean) {
    setBusy(true);
    setPending({ ...pending, [key]: value });
    try {
      await trpc.admin.sources.setWrites.mutate({
        tableId: exposure.tableId,
        ...writes,
        [key]: value,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: api.admin.sources.tables.queryKey({ id: props.sourceId }),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.list.queryKey(),
        }),
      ]);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPending({});
      setBusy(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={t`Writes allowed in this base`}
      className="flex basis-full flex-wrap items-center gap-x-4 gap-y-1 pr-3 pb-2 text-sm"
    >
      {rights.map((right) => (
        <label key={right.key} className="flex items-center gap-1.5">
          <Checkbox
            ref={(box) => {
              if (box) boxes.current.set(right.key, box);
              else boxes.current.delete(right.key);
            }}
            checked={writes[right.key]}
            disabled={busy || !table.privileges[right.key]}
            onChange={(event) => {
              setLast(right.key);
              void toggle(right.key, event.target.checked);
            }}
          />
          {right.label}
        </label>
      ))}
      {missing.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          {t`The account lacks ${{ rights: missing.join(", ") }} on this table.`}
        </span>
      ) : null}
    </div>
  );
}

/** A column name that usually holds a row's last change. */
const CHANGED = /(updated|modified|changed|modif|last_update|maj|edited)/i;

/**
 * Where the table is read (ADR 0034): live in the client's database, or
 * from a copy in AnyGridDB refreshed every few minutes, for a DBA who
 * refuses live queries. What the last refresh did shows.
 */
function TableSync(props: {
  exposure: Exposure;
  sourceId: string;
  /** Client columns that tell changes: the incremental mode reads them. */
  changeColumns: ReadonlyArray<{ name: string }>;
}) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { exposure } = props;
  const sync = exposure.sync;
  const [minutes, setMinutes] = useState(String(sync?.intervalMinutes ?? 15));
  const [mode, setMode] = useState<"full" | "incremental">(
    sync?.syncMode ?? "full",
  );
  const [changeColumn, setChangeColumn] = useState(sync?.changeColumn ?? "");
  const [fullEvery, setFullEvery] = useState(String(sync?.fullEvery ?? 24));
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.sources.tables.queryKey({ id: props.sourceId }),
      });
      await queryClient.invalidateQueries({
        queryKey: api.admin.sources.exposures.queryKey({ id: props.sourceId }),
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const save = (
    intervalMinutes: number | null,
    next?: {
      syncMode?: "full" | "incremental";
      changeColumn?: string | null;
      fullEvery?: number;
    },
  ) =>
    run(() =>
      trpc.admin.sources.setSync.mutate({
        tableId: exposure.tableId,
        intervalMinutes,
        syncMode: next?.syncMode ?? mode,
        changeColumn:
          (next?.syncMode ?? mode) === "incremental"
            ? (next?.changeColumn ?? changeColumn) || null
            : null,
        fullEvery:
          (next?.syncMode ?? mode) === "incremental"
            ? (next?.fullEvery ?? fullEveryWanted)
            : undefined,
      }),
    );
  const wanted = Math.min(10_080, Math.max(1, Math.round(Number(minutes))));
  const fullEveryWanted = Math.min(
    10_080,
    Math.max(1, Math.round(Number(fullEvery)) || 24),
  );
  const id = `sync-${exposure.tableId}`;
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 pr-3 pb-2 text-sm">
      <Label htmlFor={id} className="text-sm">
        {t`Reading`}
      </Label>
      <Select
        id={id}
        value={sync ? "copy" : "live"}
        disabled={busy}
        onChange={(event) =>
          void save(
            event.target.value === "copy"
              ? Number.isFinite(wanted)
                ? wanted
                : 15
              : null,
          )
        }
      >
        <option value="live">{t`Live in the client's database`}</option>
        <option value="copy">{t`Copy in AnyGridDB`}</option>
      </Select>
      {sync ? (
        <>
          <label className="flex items-center gap-1.5">
            {t`refreshed every`}
            <Input
              aria-label={t`Interval in minutes`}
              className="h-8 w-20"
              inputMode="numeric"
              value={minutes}
              disabled={busy}
              onChange={(event) => setMinutes(event.target.value)}
              onBlur={() => {
                if (Number.isFinite(wanted) && wanted !== sync.intervalMinutes)
                  void save(wanted);
              }}
            />
            {t`min`}
          </label>
          <label className="flex items-center gap-1.5">
            {t`mode`}
            <Select
              aria-label={t`Refresh mode`}
              className="h-8"
              value={mode}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as "full" | "incremental";
                setMode(next);
                // Incremental waits for its column: saved once it is chosen.
                if (next === "full" || changeColumn) {
                  void save(wanted, { syncMode: next });
                }
              }}
            >
              <option value="full">{t`Full copy`}</option>
              <option value="incremental">{t`Incremental`}</option>
            </Select>
          </label>
          {mode === "incremental" ? (
            <>
              <label className="flex items-center gap-1.5">
                {t`change column`}
                <Select
                  aria-label={t`Change column`}
                  className="h-8 w-44 font-mono text-xs"
                  value={changeColumn}
                  disabled={busy || props.changeColumns.length === 0}
                  onChange={(event) => {
                    const next = event.target.value;
                    setChangeColumn(next);
                    if (next && next !== (sync.changeColumn ?? ""))
                      void save(wanted, {
                        syncMode: "incremental",
                        changeColumn: next,
                      });
                  }}
                >
                  <option value="">{t`Choose a column`}</option>
                  {props.changeColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-1.5">
                {t`full reconcile every`}
                <Input
                  aria-label={t`Full reconcile every N refreshes`}
                  className="h-8 w-20"
                  inputMode="numeric"
                  value={fullEvery}
                  disabled={busy}
                  onChange={(event) => setFullEvery(event.target.value)}
                  onBlur={() => {
                    if (
                      Number.isFinite(fullEveryWanted) &&
                      fullEveryWanted !== sync.fullEvery
                    )
                      void save(wanted, {
                        syncMode: "incremental",
                        fullEvery: fullEveryWanted,
                      });
                  }}
                />
                {t`refreshes`}
              </label>
            </>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() =>
                trpc.admin.sources.syncNow.mutate({
                  tableId: exposure.tableId,
                }),
              )
            }
          >
            {t`Refresh now`}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {sync.errorCode
              ? errorText({ data: { reason: { code: sync.errorCode } } })
              : sync.syncedAt
                ? `${t`Copied on ${{ date: new Date(sync.syncedAt).toLocaleString(i18n.locale) }}`} · ${plural(sync.rows ?? 0, { one: `# row`, other: `# rows` })} · ${plural(sync.changes, { 0: "no change", one: `# row changed`, other: `# rows changed` })}`
                : t`First copy in progress: the table is read live until then`}
          </span>
          <p className="basis-full text-xs text-muted-foreground">
            {mode === "incremental" && props.changeColumns.length === 0
              ? t`No column of this table tells when a row changes (a date and time set on every change, or a rowversion): keep the full copy.`
              : mode === "incremental"
                ? t`Incremental upserts rows that moved since the last pass; a full reconcile (deletes included) runs every ${{ count: sync.fullEvery }} refreshes.`
                : t`The table is read from its copy: it can no longer be changed in AnyGridDB, and its changes arrive with each refresh, deletes included.`}
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * How changes other applications make in the table are told (ADR 0031):
 * a column the database sets on every change, or SQL Server's Change
 * Tracking, checked on an interval. What the last check found shows.
 */
function TableWatch(props: {
  table: SourceTableItem;
  exposure: Exposure;
  sourceId: string;
}) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { table, exposure } = props;
  const watch = exposure.watch;
  const current =
    watch === null
      ? ""
      : watch.method === "change_tracking"
        ? "change_tracking"
        : `column:${watch.column ?? ""}`;
  const [interval, setIntervalText] = useState(
    String(watch?.intervalSeconds ?? 30),
  );
  const [busy, setBusy] = useState(false);
  const suggested = table.watchColumns.find((column) =>
    CHANGED.test(column.name),
  );

  async function save(choice: string, seconds: number) {
    setBusy(true);
    try {
      await trpc.admin.sources.setWatch.mutate({
        tableId: exposure.tableId,
        method:
          choice === ""
            ? null
            : choice === "change_tracking"
              ? "change_tracking"
              : "column",
        ...(choice.startsWith("column:")
          ? { column: choice.slice("column:".length) }
          : {}),
        intervalSeconds: seconds,
      });
      await queryClient.invalidateQueries({
        queryKey: api.admin.sources.tables.queryKey({ id: props.sourceId }),
      });
      await queryClient.invalidateQueries({
        queryKey: api.admin.sources.exposures.queryKey({ id: props.sourceId }),
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const seconds = Math.min(86_400, Math.max(5, Math.round(Number(interval))));
  const time = (value: Date | string | null) =>
    value === null
      ? ""
      : new Date(value).toLocaleTimeString(i18n.locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
  const id = `watch-${exposure.tableId}`;
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 pr-3 pb-2 text-sm">
      <Label htmlFor={id} className="text-sm">
        {t`Changes made elsewhere`}
      </Label>
      <Select
        id={id}
        value={current}
        disabled={busy}
        onChange={(event) =>
          void save(event.target.value, Number.isFinite(seconds) ? seconds : 30)
        }
      >
        <option value="">{t`Not watched`}</option>
        {table.changeTracking ? (
          <option value="change_tracking">{t`SQL Server Change Tracking`}</option>
        ) : null}
        {table.watchColumns.map((column) => (
          <option key={column.name} value={`column:${column.name}`}>
            {column === suggested
              ? t`Column ${{ column: column.name }} (suggested)`
              : t`Column ${{ column: column.name }}`}
          </option>
        ))}
      </Select>
      {watch ? (
        <>
          <label className="flex items-center gap-1.5">
            {t`every`}
            <Input
              aria-label={t`Interval in seconds`}
              className="h-8 w-20"
              inputMode="numeric"
              value={interval}
              disabled={busy}
              onChange={(event) => setIntervalText(event.target.value)}
              onBlur={() => {
                if (
                  Number.isFinite(seconds) &&
                  seconds !== watch.intervalSeconds
                )
                  void save(current, seconds);
              }}
            />
            {t`s`}
          </label>
          <span role="status" className="text-xs text-muted-foreground">
            {watch.errorCode
              ? errorText({ data: { reason: { code: watch.errorCode } } })
              : watch.checkedAt
                ? `${t`Checked at ${{ time: time(watch.checkedAt) }}`} · ${plural(watch.changes, { 0: "no change", one: `# row changed`, other: `# rows changed` })}`
                : t`First check under way`}
          </span>
        </>
      ) : table.watchColumns.length === 0 && !table.changeTracking ? (
        <span className="text-xs text-muted-foreground">
          {t`No date and time column of the last change: changes other applications make show at the next read.`}
        </span>
      ) : null}
    </div>
  );
}
