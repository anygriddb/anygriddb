import { filterGap, type FilterGroup } from "@anygriddb/core";
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
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { ConfirmDialog } from "../shell/dialogs";
import { FilterBuilder } from "../table/filter-builder";
import { useRoleLabel } from "./role-label";
import {
  narrowable,
  restricts,
  ruleSubjects,
  ruleToSave,
  storedAccess,
  subjectInput,
  subjectKey,
  subjectShown,
  type FieldAccess,
  type RuleSubject,
} from "./table-rules";

/** Who reaches the table, as `catalog.tableAccess` lists them. */
type Reach = RouterOutputs["catalog"]["tableAccess"];

/** What was changed for one person or group and is not saved yet. */
type Draft = {
  key: string;
  rowFilter?: FilterGroup | null;
  access?: Record<string, FieldAccess>;
};

/** Rows of the table a preview shows. */
const PREVIEW_ROWS = 5;

/**
 * One person's or one group's permissions on a table: the rows they see,
 * what they may do with each field, and, for a person, a look at the
 * table as they read it. Whoever manages the table has none to set: they
 * read and change everything.
 */
export function TableRulesPanel(props: {
  baseId: string;
  tableId: string;
  /** The table's name: a base's settings hold a panel for each table. */
  tableName: string;
  columns: readonly CatalogColumn[];
  /** Everyone with a role on the table, and the groups given one there. */
  reach: Reach;
  people: ReadonlyMap<string, Collaborator>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const rules = useQuery(
    api.catalog.tableAcl.queryOptions({ tableId: props.tableId }),
  );
  const subjects = ruleSubjects(props.reach.people, props.reach.groups);
  const [chosen, setChosen] = useState("");
  const key = subjectShown(subjects, chosen);
  const subject = subjects.find((item) => item.key === key);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState(false);
  // Giving a role table by table is asked first: nobody undoes it alone.
  const [splitting, setSplitting] = useState(false);
  const userId = subject?.kind === "person" ? subject.userId : "";
  // The table as the person shown reads it, once it is asked for.
  const preview = useQuery({
    ...api.catalog.viewAs.queryOptions({
      tableId: props.tableId,
      userId,
      limit: PREVIEW_ROWS,
    }),
    enabled: viewing && userId !== "",
  });

  if (!subject) {
    return (
      <p className="text-sm text-muted-foreground">
        {t`A rule narrows only a role given on this table. Give someone or a group a role here, and none on the base (which gives them the whole table), to set which rows and fields they see.`}
      </p>
    );
  }

  const groups = subjects.filter((item) => item.kind === "group");
  const stored = rules.data?.rules.find((rule) => subjectKey(rule) === key);
  const own = draft?.key === key ? draft : null;
  const access =
    own?.access ??
    storedAccess(
      stored,
      props.columns.map((column) => column.name),
    );
  const rowFilter =
    own?.rowFilter !== undefined ? own.rowFilter : (stored?.rowFilter ?? null);
  const edit = (patch: Omit<Draft, "key">) =>
    setDraft({ ...own, ...patch, key });
  const name = subject.displayName;
  const isGroup = subject.kind === "group";

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

  async function save(target: RuleSubject) {
    const gap = rowFilter ? filterGap(rowFilter) : null;
    if (gap) {
      const field =
        gap.kind === "blank"
          ? (props.columns.find((column) => column.name === gap.column)
              ?.label ?? gap.column)
          : "";
      toast.error(
        gap.kind === "empty"
          ? t`Add a condition on the rows ${{ name: target.displayName }} sees, or choose Every row.`
          : t`The condition on ${{ field }} has no value yet: give it one, or remove it.`,
      );
      return;
    }
    const rule = ruleToSave(access, rowFilter);
    try {
      await trpc.catalog.setTableAcl.mutate({
        tableId: props.tableId,
        ...subjectInput(target),
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

  async function clear(target: RuleSubject) {
    try {
      await trpc.catalog.clearTableAcl.mutate({
        tableId: props.tableId,
        ...subjectInput(target),
      });
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await refresh();
    toast.success(t`Restrictions cleared`);
  }

  const choice = (item: RuleSubject) => (
    <option key={item.key} value={item.key}>
      {item.displayName}
    </option>
  );

  return (
    <section
      aria-label={t`Permissions on ${{ table: props.tableName }}`}
      className="flex flex-col gap-3 rounded-sm border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{t`Permissions of`}</span>
        <Select
          aria-label={t`Whose permissions are set`}
          className="w-56"
          value={key}
          onChange={(event) => {
            setChosen(event.target.value);
            setDraft(null);
            setViewing(false);
          }}
        >
          {groups.length === 0 ? (
            subjects.map(choice)
          ) : (
            <>
              <optgroup label={t`People`}>
                {subjects.filter((item) => item.kind === "person").map(choice)}
              </optgroup>
              <optgroup label={t`Groups`}>{groups.map(choice)}</optgroup>
            </>
          )}
        </Select>
        {isGroup ? null : (
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
        )}
      </div>
      {rules.isLoading ? <Spinner /> : null}

      {narrowable(subject) ? (
        <>
          {isGroup ? (
            <p className="text-xs text-muted-foreground">
              {t`These permissions bind each member of the group who holds nothing more on this table. A role of their own, or another group's, adds to them. To see the table as one of them reads it, choose them under People.`}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t`Rows`}
              </span>
              <Select
                aria-label={
                  isGroup
                    ? t`Rows the members of ${{ name }} see`
                    : t`Rows this member sees`
                }
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
                  {isGroup
                    ? t`A row that does not match is hidden from them in every view, export, and answer of the API. “Me”, in a collaborator field, keeps each member to their own rows.`
                    : t`A row that does not match is hidden from this member in every view, export, and answer of the API. “Me”, in a collaborator field, keeps each person to their own rows.`}
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
                    aria-label={
                      isGroup
                        ? t`What the members of ${{ name }} may do with ${{ field: column.label }}`
                        : t`What this member may do with ${{ field: column.label }}`
                    }
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
            <Button size="sm" onClick={() => void save(subject)}>
              {t`Save`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void clear(subject)}
            >
              {t`Clear restrictions`}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2 text-sm">
          <Unnarrowed
            subject={subject}
            splitting={splitting}
            onSplitting={setSplitting}
            onSplit={split}
          />
        </div>
      )}

      {viewing && !isGroup ? (
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

/**
 * Why a rule cannot narrow this person or group here, and for someone
 * whose own role on the base gives the table whole, the way out.
 */
function Unnarrowed(props: {
  subject: RuleSubject;
  splitting: boolean;
  onSplitting: (open: boolean) => void;
  onSplit: () => Promise<void>;
}) {
  const { t } = useLingui();
  const { subject } = props;
  const name = subject.displayName;
  if (subject.kind === "group") {
    return (
      <p className="text-muted-foreground">
        {t`The group ${{ name }} also holds a role on the base, which gives this table whole: a rule cannot narrow it. Remove the group's role on the base to narrow it here.`}
      </p>
    );
  }
  if (subject.baseOwn) {
    return (
      <>
        <p className="text-muted-foreground">
          {t`${{ name }} reaches this table through their role on the base, which gives it whole. To narrow what they see here, give them that role on each table of the base instead.`}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => props.onSplitting(true)}
        >
          {t`Give the role table by table`}
        </Button>
        <ConfirmDialog
          open={props.splitting}
          onOpenChange={props.onSplitting}
          title={t`Give ${{ name }} their role table by table?`}
          description={t`They keep their role on each table the base holds now, and no longer hold it on the base: a table made later is not theirs until someone gives it to them.`}
          confirmLabel={t`Give it table by table`}
          onConfirm={props.onSplit}
        />
      </>
    );
  }
  if (subject.baseRole !== null) {
    return (
      <p className="text-muted-foreground">
        {t`A group gives ${{ name }} their role on the base, which gives this table whole: a rule cannot narrow it.`}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground">
      {t`${{ name }} reaches this table through a group's role on it: set that group's permissions here, or give ${{ name }} a role of their own on this table to set theirs.`}
    </p>
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
