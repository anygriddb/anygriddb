/**
 * Client databases (ADR 0026). An administrator declares a source with a
 * dedicated account; it is saved only once a connection succeeds, over
 * verified TLS. The password is written, never shown again.
 */
import {
  DEFAULT_SOURCE_PORTS,
  SOURCE_ENGINES,
  isCopySourceEngine,
  sourceDatabaseField,
  type SourceEngine,
  type SourceInput,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  cn,
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
import { Plus, RefreshCw, ShieldAlert, Table2 } from "lucide-react";
import { sortRows } from "../../lib/sort-rows";
import { useColumnSort } from "../sort-header";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { ENGINE_NAMES } from "../../lib/limits";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { raw } from "../../lib/known-text";
import { FIELD_LABELS } from "../fields/field-meta";
import { ConfirmDialog } from "../shell/dialogs";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";
import { EngineMark } from "./engine-mark";
import { RefreshFields } from "./refresh-fields";
import { intlLocale, formatInstant } from "../../lib/format";
import { useWhen } from "../../lib/i18n";

type Source = RouterOutputs["admin"]["sources"]["list"][number];
type SourceTableItem = RouterOutputs["admin"]["sources"]["tables"][number];
type Exposure = SourceTableItem["exposedIn"][number];
type Right = keyof Exposure["writes"];

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function SourcesTab() {
  const { t } = useLingui();
  const when = useWhen();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.sources.settings.queryOptions());
  const list = useQuery(api.admin.sources.list.queryOptions());
  const [pageSize, setPageSize] = useAdminPageSize();
  const { page, setPage, offset, limit } = useAdminPage(pageSize);
  const columns = useColumnSort<
    | "name"
    | "address"
    | "account"
    | "schema"
    | "version"
    | "replica"
    | "checked"
  >();
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [browsing, setBrowsing] = useState<Source | null>(null);
  const allSources = list.data ?? [];
  const pageSources = sortRows(
    allSources.slice(offset, offset + limit),
    columns.sort,
    (source, key) => {
      if (key === "name") return source.name;
      if (key === "address") {
        return `${source.host}:${String(source.port)}/${source.database}`;
      }
      if (key === "account") return source.username;
      if (key === "schema") return source.sideSchema;
      if (key === "version") return source.serverVersion;
      if (key === "replica") return source.replicaHost;
      return source.checkedAt;
    },
    (source) => source.id,
  );
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
  const impact = settings.data?.impact;
  const blockedListed = allSources.filter((source) => !source.hostAllowed);
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
      {allowed.length === 0 ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
        >
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden
          />
          <span>
            {t`No host is allowed: the operator sets ANYGRIDDB_SOURCES_ALLOWED_HOSTS. New sources cannot be added. Live tables and bases held in a source cannot reach the client; synced tables keep their last copy until the host is allowed again.`}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t`Allowed hosts, set by ANYGRIDDB_SOURCES_ALLOWED_HOSTS: ${{ hosts: allowed.join(", ") }}`}
        </p>
      )}
      {impact && impact.sources > 0 ? (
        <p className="text-sm text-muted-foreground">
          {plural(impact.sources, {
            one: `# source`,
            other: `# sources`,
          })}
          {" · "}
          {plural(impact.liveTables, {
            one: `# live table`,
            other: `# live tables`,
          })}
          {" · "}
          {plural(impact.syncedTables, {
            one: `# synced table`,
            other: `# synced tables`,
          })}
          {" · "}
          {plural(impact.hostedBases, {
            one: `# base held in a source`,
            other: `# bases held in a source`,
          })}
        </p>
      ) : null}
      {impact && impact.blockedSources > 0 ? (
        <p role="status" className="text-sm">
          {[
            plural(impact.blockedSources, {
              one: `# source refused by the allow list`,
              other: `# sources refused by the allow list`,
            }),
            impact.unreachableTables > 0
              ? plural(impact.unreachableTables, {
                  one: `# table cannot be read`,
                  other: `# tables cannot be read`,
                })
              : null,
            impact.frozenTables > 0
              ? plural(impact.frozenTables, {
                  one: `# synced table stays on its last copy`,
                  other: `# synced tables stay on their last copy`,
                })
              : null,
            impact.unreachableBases > 0
              ? plural(impact.unreachableBases, {
                  one: `# base held in a source cannot be read`,
                  other: `# bases held in a source cannot be read`,
                })
              : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
      ) : null}
      {blockedListed.length > 0 && allowed.length > 0 ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
        >
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden
          />
          <span>
            {plural(blockedListed.length, {
              one: `# declared source sits on a host outside the allow list: its connections are refused until the operator adds that host.`,
              other: `# declared sources sit on hosts outside the allow list: their connections are refused until the operator adds those hosts.`,
            })}
          </span>
        </p>
      ) : null}
      <div>
        <Button
          size="sm"
          disabled={allowed.length === 0}
          onClick={() => setEditing("new")}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add a source`}
        </Button>
      </div>
      {list.isLoading ? <Spinner /> : null}
      {list.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`No source yet. Add one to show its tables in a base, read and written where they live.`}
        </p>
      ) : null}
      {allSources.length > 0 ? (
        <>
          <AdminTable>
            <AdminTableHead className="text-muted-foreground">
              <tr>
                {columns.header("name", t`Name`, "px-3 py-2")}
                {columns.header("address", t`Address`, "px-3 py-2")}
                {columns.header("account", t`Account`, "px-3 py-2")}
                {columns.header("schema", t`Side schema`, "px-3 py-2")}
                {columns.header("version", t`Version`, "px-3 py-2")}
                {columns.header("replica", t`Replica`, "px-3 py-2")}
                {columns.header("checked", t`Checked`, "px-3 py-2")}
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </AdminTableHead>
            <tbody>
              {pageSources.map((source) => (
                <tr key={source.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">
                    <span className="flex items-center gap-1.5">
                      <EngineMark engine={source.engine} className="h-4 w-4" />
                      {source.name}
                      {!source.hostAllowed ? (
                        <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-normal text-foreground">
                          {source.replicaBlocked
                            ? t`Replica host not allowed`
                            : t`Host not allowed`}
                        </span>
                      ) : null}
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
                    {source.checkedAt ? when.instant(source.checkedAt) : "—"}
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
          </AdminTable>
          <AdminPager
            total={allSources.length}
            offset={offset}
            pageSize={pageSize}
            onPageSize={setPageSize}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
          />
        </>
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
        title={props.target === "new" ? t`Add a source` : t`Edit the source`}
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

  // A store read from a copy (ADR 0088): no field of AnyGridDB's is kept
  // there, no replica is read, and its dates carry their zone.
  const copyOnly = isCopySourceEngine(engine);

  function input(): SourceInput {
    const primaryPort = Number(port);
    const replica = copyOnly ? "" : replicaHost.trim();
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
      timeZone: copyOnly ? "UTC" : timeZone.trim() || "UTC",
      sideSchema: copyOnly ? null : sideSchema.trim() || null,
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
    database.trim() &&
    host.trim() &&
    username.trim() &&
    (password || existing);
  const databaseField = sourceDatabaseField(engine);
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
      <fieldset className="col-span-2 flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          {t`Engine`}
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SOURCE_ENGINES.map((value) => {
            const selected = engine === value;
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm hover:bg-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
                  selected
                    ? "border-primary ring-1 ring-primary"
                    : "border-border",
                )}
              >
                <input
                  type="radio"
                  name="source-engine"
                  className="sr-only"
                  value={value}
                  checked={selected}
                  onChange={() => {
                    setEngine(value);
                    setPort(String(DEFAULT_SOURCE_PORTS[value]));
                  }}
                />
                <EngineMark engine={value} className="h-6 w-6" />
                <span className="min-w-0 truncate font-medium">
                  {ENGINE_NAMES[value]}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="source-database">
          {databaseField === "service"
            ? t`Service name`
            : databaseField === "indices"
              ? t`Indices`
              : t`Database`}
        </Label>
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
      {copyOnly ? (
        <p className="col-span-2 text-xs text-muted-foreground">
          {t`AnyGridDB reads this source from a copy: each table you expose is read whole, once per interval, and people read the copy. Nothing is ever written to the source. Give the account the right to read its database, and nothing more.`}
        </p>
      ) : (
        <>
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
            <p
              id="source-time-zone-help"
              className="text-xs text-muted-foreground"
            >
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
              {t`Fields people add to this source's tables are kept there, one side table per exposed table (a database on MySQL and MariaDB, the account's own schema on Oracle). Left empty, AnyGridDB keeps them in its own database: they filter a view, but cannot sort or group it. The client's tables are never changed.`}
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
        </>
      )}
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
  const copyOnly = isCopySourceEngine(props.source.engine);
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
                <SourceColumns columns={table.columns} />
              </details>
              {exposure && !copyOnly ? (
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
                  copyOnly={copyOnly}
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
  /** A store read from a copy only (ADR 0088): whole, never live. */
  copyOnly: boolean;
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
      {props.copyOnly ? (
        <span>
          {t`Reading`} · {t`Copy in AnyGridDB`}
        </span>
      ) : (
        <>
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
        </>
      )}
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
          {props.copyOnly ? null : (
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
          )}
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
                ? `${t`Copied on ${{ date: formatInstant(sync.syncedAt, i18n.locale) }}`} · ${plural(sync.rows ?? 0, { one: `# row`, other: `# rows` })} · ${plural(sync.changes, { 0: "no change", one: `# row changed`, other: `# rows changed` })}`
                : props.copyOnly
                  ? t`First copy in progress: the table shows empty until then`
                  : t`First copy in progress: the table is read live until then`}
          </span>
          {sync.leftOut > 0 && !sync.errorCode ? (
            <span role="status" className="text-xs text-warning">
              {plural(sync.leftOut, {
                one: `# value is not of its field's type and reads empty. Refresh fields to follow the source.`,
                other: `# values are not of their field's type and read empty. Refresh fields to follow the source.`,
              })}
            </span>
          ) : null}
          <p className="basis-full text-xs text-muted-foreground">
            {mode === "incremental" && props.changeColumns.length === 0
              ? t`No column of this table tells when a row changes (a date and time set on every change, or a rowversion): keep the full copy.`
              : mode === "incremental"
                ? t`Incremental upserts rows that moved since the last pass; a full reconcile (deletes included) runs every ${{ count: sync.fullEvery }} refreshes.`
                : props.copyOnly
                  ? t`The table is read from its copy, a million rows at most; its changes arrive with each refresh, deletes included.`
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
      : new Date(value).toLocaleTimeString(intlLocale(i18n.locale), {
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

/** The columns of one table a source can read, sorted while the page is open. */
function SourceColumns({ columns }: { columns: SourceTableItem["columns"] }) {
  const { t } = useLingui();
  const sorting = useColumnSort<"name" | "type" | "field">();
  const rows = sortRows(
    columns,
    sorting.sort,
    (column, key) => {
      if (key === "name") return column.name;
      if (key === "type") return column.type;
      return column.field.fieldType;
    },
    (column) => column.name,
  );
  return (
    <table className="w-full border-t border-border text-xs">
      <thead className="bg-muted text-left text-muted-foreground">
        <tr>
          {sorting.header("name", t`Column`, "px-3 py-1")}
          {sorting.header("type", t`Source type`, "px-3 py-1")}
          {sorting.header("field", t`Field`, "px-3 py-1")}
        </tr>
      </thead>
      <tbody>
        {rows.map((column) => (
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
  );
}
