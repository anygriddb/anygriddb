import type { FilterGroup } from "@anygriddb/core";
import { Button, Select, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Shield } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import type { CatalogColumn, Collaborator, Grant } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { ConfirmDialog } from "../shell/dialogs";
import { FilterBuilder } from "../table/filter-builder";
import { useRoleLabel } from "./role-label";
import {
  memberShown,
  narrowable,
  restricts,
  ruledMembers,
  ruleGap,
  ruleToSave,
  storedAccess,
  type FieldAccess,
} from "./table-rules";

type Member = {
  userId: string;
  displayName: string;
  baseRole: Grant | null;
  tableRole: Grant | null;
  /** Whether their role on the base is their own, not a group's. */
  baseOwn: boolean;
};

/** What was changed for one member and is not saved yet. */
type Draft = {
  userId: string;
  rowFilter?: FilterGroup | null;
  access?: Record<string, FieldAccess>;
};

/** Rows of the table a preview shows. */
const PREVIEW_ROWS = 5;

/**
 * One member's permissions on a table: the rows they see, what they may
 * do with each field, and a look at the table as they read it. An owner
 * of the table has none to set: they read and change everything.
 */
export function TableRulesPanel(props: {
  baseId: string;
  tableId: string;
  /** The table's name: a base's settings hold a panel for each table. */
  tableName: string;
  columns: readonly CatalogColumn[];
  /** Everyone with a role on the table, with that role. */
  members: readonly Member[];
  people: ReadonlyMap<string, Collaborator>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const rules = useQuery(
    api.catalog.tableAcl.queryOptions({ tableId: props.tableId }),
  );
  const ruled = ruledMembers(props.members);
  const [chosen, setChosen] = useState("");
  const userId = memberShown(ruled, chosen);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState(false);
  // Giving a role table by table is asked first: nobody undoes it alone.
  const [splitting, setSplitting] = useState(false);
  // The table as the member shown reads it, once it is asked for.
  const preview = useQuery({
    ...api.catalog.viewAs.queryOptions({
      tableId: props.tableId,
      userId,
      limit: PREVIEW_ROWS,
    }),
    enabled: viewing && userId !== "",
  });

  if (ruled.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t`A rule narrows only a role given on this table. Give someone a role here, and none on the base (which gives them the whole table), to set which rows and fields they see.`}
      </p>
    );
  }

  const person = ruled.find((member) => member.userId === userId);
  const stored = rules.data?.rules.find((rule) => rule.userId === userId);
  const own = draft?.userId === userId ? draft : null;
  const access =
    own?.access ??
    storedAccess(
      stored,
      props.columns.map((column) => column.name),
    );
  const rowFilter =
    own?.rowFilter !== undefined ? own.rowFilter : (stored?.rowFilter ?? null);
  const edit = (patch: Omit<Draft, "userId">) =>
    setDraft({ ...own, ...patch, userId });

  async function refresh() {
    setDraft(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.catalog.tableAcl.queryKey({ tableId: props.tableId }),
      }),
      queryClient.invalidateQueries({
        queryKey: api.catalog.viewAs.pathKey(),
      }),
    ]);
  }

  async function save() {
    const gap = rowFilter ? ruleGap(rowFilter) : null;
    if (gap) {
      const field =
        gap.kind === "blank"
          ? (props.columns.find((column) => column.name === gap.column)
              ?.label ?? gap.column)
          : "";
      toast.error(
        gap.kind === "empty"
          ? t`Add a condition on the rows this member sees, or choose Every row.`
          : t`The condition on ${{ field }} has no value yet: give it one, or remove it.`,
      );
      return;
    }
    const rule = ruleToSave(access, rowFilter);
    try {
      await trpc.catalog.setTableAcl.mutate({
        tableId: props.tableId,
        userId,
        rowFilter: rule.rowFilter,
        columns: [...rule.columns],
      });
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await refresh();
    toast.success(
      restricts(rule) ? t`Permissions saved` : t`Restrictions cleared`,
    );
  }

  /**
   * Their own role on the base, given table by table so a rule may narrow
   * it, once confirmed: a refusal is said in the dialog that asked.
   */
  async function split() {
    await trpc.catalog.splitBaseRole.mutate({
      baseId: props.baseId,
      userId,
    });
    setSplitting(false);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.catalog.tableAccess.pathKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: api.catalog.members.pathKey(),
      }),
    ]);
    await refresh();
    toast.success(t`Role given table by table`);
  }

  async function clear() {
    try {
      await trpc.catalog.clearTableAcl.mutate({
        tableId: props.tableId,
        userId,
      });
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await refresh();
    toast.success(t`Restrictions cleared`);
  }

  return (
    <section
      aria-label={t`Permissions on ${{ table: props.tableName }}`}
      className="flex flex-col gap-3 rounded-sm border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{t`Permissions of`}</span>
        <Select
          aria-label={t`Member whose permissions are set`}
          className="w-56"
          value={userId}
          onChange={(event) => {
            setChosen(event.target.value);
            setDraft(null);
            setViewing(false);
          }}
        >
          {ruled.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.displayName}
            </option>
          ))}
        </Select>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          aria-expanded={viewing}
          onClick={() => setViewing(true)}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {t`View as`}
        </Button>
      </div>
      {rules.isLoading ? <Spinner /> : null}

      {person && narrowable(person) ? (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t`Rows`}
              </span>
              <Select
                aria-label={t`Rows this member sees`}
                className="h-8 w-64"
                value={rowFilter === null ? "all" : "some"}
                onChange={(event) =>
                  edit({
                    rowFilter:
                      event.target.value === "all"
                        ? null
                        : { conjunction: "and", conditions: [] },
                  })
                }
              >
                <option value="all">{t`Every row`}</option>
                <option value="some">{t`Only the rows that match`}</option>
              </Select>
            </div>
            {rowFilter === null ? null : (
              <>
                <FilterBuilder
                  group={rowFilter}
                  columns={props.columns}
                  people={props.people}
                  onChange={(group) => edit({ rowFilter: group })}
                />
                <p className="text-xs text-muted-foreground">
                  {t`A row that does not match is hidden from this member in every view, export, and answer of the API. “Me”, in a collaborator field, keeps each person to their own rows.`}
                </p>
              </>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t`Fields`}
            </span>
            <ul className="divide-y divide-border text-sm">
              {props.columns.map((column) => (
                <li
                  key={column.name}
                  className="flex items-center gap-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {column.label}
                  </span>
                  <Select
                    aria-label={t`What this member may do with ${{ field: column.label }}`}
                    className="h-8 w-44"
                    value={access[column.name] ?? "write"}
                    onChange={(event) =>
                      edit({
                        access: {
                          ...access,
                          [column.name]: event.target.value as FieldAccess,
                        },
                      })
                    }
                  >
                    <option value="write">{t`Read and write`}</option>
                    <option value="read">{t`Read only`}</option>
                    <option value="hide">{t`Hidden`}</option>
                  </Select>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save()}>
              {t`Save`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clear()}>
              {t`Clear restrictions`}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2 text-sm">
          {person?.baseOwn ? (
            <>
              <p className="text-muted-foreground">
                {t`${{ name: person.displayName }} reaches this table through their role on the base, which gives it whole. To narrow what they see here, give them that role on each table of the base instead.`}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSplitting(true)}
              >
                {t`Give the role table by table`}
              </Button>
              <ConfirmDialog
                open={splitting}
                onOpenChange={setSplitting}
                title={t`Give ${{ name: person.displayName }} their role table by table?`}
                description={t`They keep their role on each table the base holds now, and no longer hold it on the base: a table made later is not theirs until someone gives it to them.`}
                confirmLabel={t`Give it table by table`}
                onConfirm={split}
              />
            </>
          ) : (
            <p className="text-muted-foreground">
              {t`A group gives ${{ name: person?.displayName ?? "" }} their role on the base, which gives this table whole: a rule cannot narrow it.`}
            </p>
          )}
        </div>
      )}

      {viewing ? (
        <MemberPreview
          columns={props.columns}
          people={props.people}
          loading={preview.isLoading}
          failure={preview.error ? errorText(preview.error) : null}
          seen={preview.data}
          unsaved={own !== null}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </section>
  );
}

/** What the server answers of a member: their role, fields, and first rows. */
type Seen = RouterOutputs["catalog"]["viewAs"];

/**
 * The table as a member reads it: their role, how many rows they see, and
 * the first of them with the fields they may read, by the rules kept.
 */
function MemberPreview(props: {
  columns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
  loading: boolean;
  failure: string | null;
  seen: Seen | undefined;
  /** Changes were made that the preview does not hold yet. */
  unsaved: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const roleLabel = useRoleLabel();
  const seen = props.seen;
  const name = seen?.user.displayName ?? "…";
  const readable = new Map(
    (seen?.columns ?? [])
      .filter((column) => column.access !== "hide")
      .map((column) => [column.name, column.access]),
  );
  const fields = props.columns.filter((column) => readable.has(column.name));
  const rows = seen?.sample.rows ?? [];
  const visible = seen?.sample.total ?? 0;
  const shown = formatNumber(rows.length, locale);
  const total = formatNumber(visible, locale);
  return (
    <section
      aria-label={t`Preview: ${{ name }}`}
      className="flex flex-col gap-2 rounded-md border border-primary/30 bg-accent/30 p-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{t`Preview: ${{ name }}`}</p>
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          {t`Close`}
        </Button>
      </div>
      {props.loading ? <Spinner /> : null}
      {props.failure ? (
        <p role="alert" className="text-sm text-danger">
          {props.failure}
        </p>
      ) : null}
      {props.unsaved ? (
        <p className="text-xs text-muted-foreground">
          {t`Changes not saved yet are not in this preview.`}
        </p>
      ) : null}
      {seen ? (
        <>
          <p className="text-xs text-muted-foreground">
            {roleLabel(seen.role)} ·{" "}
            {plural(visible, {
              one: "# visible row",
              other: "# visible rows",
            })}
          </p>
          {fields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t`No field is visible to this member.`}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t`No row is visible to this member.`}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-sm border border-border bg-card">
              <table
                className="w-full text-left text-xs"
                aria-label={t`The first rows as ${{ name }} reads them`}
              >
                <thead>
                  <tr>
                    {fields.map((column) => (
                      <th
                        key={column.name}
                        scope="col"
                        className="border-b border-rule px-2 py-1 font-medium whitespace-nowrap text-muted-foreground"
                      >
                        {column.label}
                        {readable.get(column.name) === "read" ? (
                          <span className="font-normal"> {t`(read only)`}</span>
                        ) : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border">
                      {fields.map((column) => (
                        <td key={column.name} className="max-w-56 px-2 py-1">
                          <span className="flex min-w-0">
                            <CellValueView
                              value={row[column.name]}
                              column={column}
                              locale={locale}
                              people={props.people}
                              inColumn={false}
                            />
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visible > rows.length && rows.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t`The first ${shown} of ${total} rows`}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
