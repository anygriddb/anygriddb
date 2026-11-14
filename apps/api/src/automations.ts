import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  type AutomationAction,
  automationActionSchema,
  type AutomationStep,
  type AutomationTrigger,
  automationTriggerSchema,
  buildReadRows,
  cellText,
  type CellValue,
  coerceCellValue,
  type FilterGroup,
  effectiveTableRole,
  type EngineCatalog,
  isEmail,
  isWritableType,
  MAX_EVENT_DEPTH,
  MAX_LOOP_ROWS,
  nextScheduleRun,
  renderTemplate,
  roleAllows,
  type RowEvent,
  touchesWatched,
  webhookTemplateValues,
} from "@anygriddb/core";
import type { AutomationRow, Database } from "@anygriddb/db";
import type { Bus } from "./realtime/bus.js";
import { sql } from "kysely";
import { z } from "zod";
import { loadBindings } from "./auth/access.js";
import type { AuditTx } from "./data/audit-context.js";
import { loadEngine, type TableRow } from "./data/engine.js";
import {
  listCollaborators,
  readPage,
  writeColumns,
  type RowRecord,
} from "./data/rows.js";
import { sendMail, type SmtpConfig } from "./mail.js";
import { notify, type NotifyDeps } from "./notifications.js";
import { assertPublicHttps, failureText, postPinned } from "./webhooks.js";
import { madeNamesFor, readMailVoice } from "./settings.js";
import { liveBase, liveTable } from "./data/live.js";
import { addJob, TASKS } from "./queue/jobs.js";
import { acquireLock } from "./realtime/locks.js";
import {
  createRows,
  deleteRows,
  findLiveTable,
  loadRowScope,
  updateRows,
  type RowScope,
  type RowServiceDeps,
} from "./services/rows.js";

export type AutomationDeps = {
  db: Database;
  bus: Bus;
  smtp: SmtpConfig;
  webOrigin: string;
  log: (error: unknown, message: string) => void;
};

/** Runs one automation may start per minute, whatever triggers it. */
const RUNS_PER_MINUTE = 300;
const RUN_RETENTION_DAYS = 30;
const MAX_EMAIL_RECIPIENTS = 10;

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

function parseStored(row: AutomationRow): {
  trigger: AutomationTrigger;
  actions: AutomationAction[];
} | null {
  const trigger = automationTriggerSchema.safeParse(row.trigger);
  const actions = z.array(automationActionSchema).safeParse(row.actions);
  return trigger.success && actions.success
    ? { trigger: trigger.data, actions: actions.data }
    : null;
}

/**
 * Checks names against the table: watched columns and filters, written
 * columns, the target table of a new record, and the button column.
 */
export async function assertAutomation(
  db: Database,
  table: TableRow,
  input: { trigger: AutomationTrigger; actions: AutomationAction[] },
): Promise<void> {
  const { engine, rows } = await loadEngine(db, table.id, () => true);
  const own = new Map(
    engine.table.columns.map((column) => [column.name, column]),
  );
  const trigger = input.trigger;
  if (
    trigger.type === "row_updated" &&
    trigger.columns?.some((name) => !own.has(name))
  ) {
    throw new AppError("invalid_automation");
  }
  if (trigger.type === "enters_filter") {
    try {
      buildReadRows(engine, { filter: trigger.filter, limit: 1 });
    } catch (error) {
      throw new AppError("invalid_automation", { cause: error });
    }
  }
  if (
    trigger.type === "button" &&
    own.get(trigger.column)?.fieldType !== "button"
  ) {
    throw new AppError("invalid_automation");
  }
  /** The live table `tableId`, in the automation's base. */
  const baseTable = async (tableId: string): Promise<TableRow> => {
    const known = rows.tables.find((item) => item.id === tableId);
    const [other] = known
      ? [known]
      : await db
          .selectFrom("dataTables")
          .selectAll()
          .where("id", "=", tableId)
          .where(liveTable())
          .limit(1)
          .execute();
    if (!other || other.baseId !== table.baseId) {
      throw new AppError("invalid_automation");
    }
    return other;
  };
  /** A filter that compiles on a table, as the run will read it. */
  const assertFilter = (on: EngineCatalog, filter: FilterGroup) => {
    try {
      buildReadRows(on, { filter, limit: 1 });
    } catch (error) {
      throw new AppError("invalid_automation", { cause: error });
    }
  };
  /** Actions about the rows of `writes`: its fields must be writable. */
  const assertSteps = async (
    list: readonly AutomationStep[],
    writes: EngineCatalog,
  ) => {
    const columns = new Map(
      writes.table.columns.map((column) => [column.name, column]),
    );
    for (const action of list) {
      if (action.type === "update_record") {
        for (const name of Object.keys(action.values)) {
          const column = columns.get(name);
          if (!column || !isWritableType(column.fieldType)) {
            throw new AppError("invalid_automation");
          }
        }
      }
      if (action.type === "create_record") {
        const other = await baseTable(action.tableId);
        const loaded = await loadEngine(db, other.id, () => true);
        const writable = new Set(
          writeColumns(loaded.engine).map((column) => column.name),
        );
        if (Object.keys(action.values).some((name) => !writable.has(name))) {
          throw new AppError("invalid_automation");
        }
      }
    }
  };
  for (const action of input.actions) {
    if (action.type === "branch") {
      assertFilter(engine, action.when);
      await assertSteps([...action.then, ...(action.otherwise ?? [])], engine);
    } else if (action.type === "for_each") {
      const other = await baseTable(action.tableId);
      const loaded = await loadEngine(db, other.id, () => true);
      if (action.filter) assertFilter(loaded.engine, action.filter);
      await assertSteps(action.actions, loaded.engine);
    } else {
      await assertSteps([action], engine);
    }
  }
}

export async function listAutomations(db: Database, tableId: string) {
  const rows = await db
    .selectFrom("automations as a")
    .leftJoin("users as u", "u.id", "a.createdBy")
    .selectAll("a")
    .select("u.displayName as createdByName")
    .where("a.tableId", "=", tableId)
    .orderBy("a.createdAt", "asc")
    .execute();
  return rows.map(({ createdByName: createdBy, ...automation }) => ({
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    trigger: automation.trigger as AutomationTrigger,
    actions: automation.actions as AutomationAction[],
    createdBy,
    nextRunAt: automation.nextRunAt?.toISOString() ?? null,
    lastRunAt: automation.lastRunAt?.toISOString() ?? null,
  }));
}

export async function automationTableId(
  db: Database,
  automationId: string,
): Promise<string> {
  const row = await db
    .selectFrom("automations")
    .select("tableId")
    .where("id", "=", automationId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row.tableId;
}

function scheduleFor(
  trigger: AutomationTrigger,
  enabled: boolean,
): Date | null {
  return trigger.type === "schedule" && enabled
    ? nextScheduleRun(trigger, new Date())
    : null;
}

/** A webhook trigger's token: what its secret address ends with. */
const HOOK_TOKEN = /^aghook_[A-Za-z0-9_-]{43}$/;

function hookHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newHookToken(): string {
  return `aghook_${randomBytes(32).toString("base64url")}`;
}

/**
 * The tables an automation's actions write, nested ones included: its
 * author needs write access to each.
 */
export function writtenTables(actions: readonly AutomationAction[]): string[] {
  const ids = new Set<string>();
  const visit = (list: readonly AutomationStep[]) => {
    for (const step of list) {
      if (step.type === "create_record") ids.add(step.tableId);
    }
  };
  for (const action of actions) {
    if (action.type === "branch")
      visit([...action.then, ...(action.otherwise ?? [])]);
    else if (action.type === "for_each") {
      ids.add(action.tableId);
      visit(action.actions);
    } else visit([action]);
  }
  return [...ids];
}

/**
 * A new secret address for a webhook automation; the old one stops. Only
 * the token's hash is kept: the address shows once.
 */
export async function renewAutomationWebhook(
  db: Database,
  automationId: string,
): Promise<string> {
  const row = await db
    .selectFrom("automations")
    .select("trigger")
    .where("id", "=", automationId)
    .executeTakeFirst();
  const trigger = automationTriggerSchema.safeParse(row?.trigger);
  if (!trigger.success || trigger.data.type !== "webhook") {
    throw new AppError("invalid_automation");
  }
  const token = newHookToken();
  await db
    .updateTable("automations")
    .set({ webhookTokenHash: hookHash(token), updatedAt: new Date() })
    .where("id", "=", automationId)
    .execute();
  return token;
}

/**
 * A call to a webhook automation's address: queues one run with the
 * body's fields as values. False when the token names no enabled one, so
 * the answer is the same whatever the reason.
 */
export async function queueWebhookRun(
  db: Database,
  token: string,
  body: unknown,
): Promise<boolean> {
  if (!HOOK_TOKEN.test(token)) return false;
  const automation = await db
    .selectFrom("automations")
    .select(["id", "trigger"])
    .where("webhookTokenHash", "=", hookHash(token))
    .where("enabled", "=", true)
    .executeTakeFirst();
  const trigger = automationTriggerSchema.safeParse(automation?.trigger);
  if (!automation || !trigger.success || trigger.data.type !== "webhook") {
    return false;
  }
  await addJob(
    db,
    TASKS.automationRun,
    { automationId: automation.id, values: webhookTemplateValues(body) },
    // Actions send mail and call URLs: a run is never repeated.
    { maxAttempts: 1 },
  );
  return true;
}

async function assertPublicWebhookActions(
  actions: readonly (AutomationAction | AutomationStep)[],
): Promise<void> {
  for (const action of actions) {
    if (action.type === "call_webhook") {
      await assertPublicHttps(action.url);
      continue;
    }
    if (action.type === "branch") {
      await assertPublicWebhookActions(action.then);
      if (action.otherwise) await assertPublicWebhookActions(action.otherwise);
      continue;
    }
    if (action.type === "for_each") {
      await assertPublicWebhookActions(action.actions);
    }
  }
}

export async function saveAutomation(
  db: Database,
  input: {
    id?: string;
    tableId: string;
    createdBy: string;
    name: string;
    enabled: boolean;
    trigger: AutomationTrigger;
    actions: AutomationAction[];
  },
): Promise<{ id: string; webhookToken?: string }> {
  // Same public-HTTPS check as table webhooks: refuse private targets at
  // save time, not only when the action runs.
  await assertPublicWebhookActions(input.actions);
  // A webhook trigger keeps its address; a new one gets one, shown once.
  const hook = input.trigger.type === "webhook";
  const current = input.id
    ? await db
        .selectFrom("automations")
        .select("webhookTokenHash")
        .where("id", "=", input.id)
        .executeTakeFirst()
    : undefined;
  const token = hook && !current?.webhookTokenHash ? newHookToken() : undefined;
  const values = {
    name: input.name,
    enabled: input.enabled,
    trigger: input.trigger,
    actions: input.actions,
    nextRunAt: scheduleFor(input.trigger, input.enabled),
    updatedAt: new Date(),
    webhookTokenHash: hook
      ? token
        ? hookHash(token)
        : (current?.webhookTokenHash ?? null)
      : null,
  };
  if (input.id) {
    // Whoever saves an automation answers for it: it runs with their rights.
    const id = input.id;
    // A changed automation starts over: rows already inside its filter
    // will trigger it again when they enter anew.
    await db.transaction().execute(async (tx) => {
      const updated = await tx
        .updateTable("automations")
        .set({ ...values, createdBy: input.createdBy })
        .where("id", "=", id)
        .returning("id")
        .execute();
      if (updated.length === 0) throw new AppError("no_row");
      await tx
        .deleteFrom("automationMatches")
        .where("automationId", "=", id)
        .execute();
    });
    return { id, ...(token ? { webhookToken: token } : {}) };
  }
  const created = await db
    .insertInto("automations")
    .values({ ...values, tableId: input.tableId, createdBy: input.createdBy })
    .returning("id")
    .executeTakeFirst();
  if (!created) throw new AppError("no_row");
  return { id: created.id, ...(token ? { webhookToken: token } : {}) };
}

export async function setAutomationEnabled(
  db: Database,
  automationId: string,
  enabled: boolean,
): Promise<void> {
  const row = await db
    .selectFrom("automations")
    .selectAll()
    .where("id", "=", automationId)
    .executeTakeFirst();
  if (!row) throw new AppError("no_row");
  const parsed = parseStored(row);
  await db
    .updateTable("automations")
    .set({
      enabled,
      nextRunAt: parsed ? scheduleFor(parsed.trigger, enabled) : null,
      updatedAt: new Date(),
    })
    .where("id", "=", automationId)
    .execute();
}

export async function deleteAutomation(
  db: Database,
  automationId: string,
): Promise<void> {
  const deleted = await db
    .deleteFrom("automations")
    .where("id", "=", automationId)
    .returning("id")
    .execute();
  if (deleted.length === 0) throw new AppError("no_row");
}

export async function listRuns(
  db: Database,
  automationId: string,
  limit: number,
) {
  const rows = await db
    .selectFrom("automationRuns as r")
    .leftJoin("users as u", "u.id", "r.triggeredBy")
    .select([
      "r.id",
      "r.rowId",
      "r.trigger",
      "r.status",
      "r.steps",
      "r.error",
      "r.startedAt",
      "r.finishedAt",
      "u.displayName as triggeredBy",
    ])
    .where("r.automationId", "=", automationId)
    .orderBy("r.startedAt", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/** The creator's view of a table, or null when they may no longer write it. */
async function creatorEngine(
  db: Database,
  userId: string,
  tableId: string,
): Promise<RowScope | null> {
  const bindings = await loadBindings(db, userId);
  const table = await findLiveTable(db, tableId);
  if (
    !table ||
    !roleAllows(effectiveTableRole(bindings, tableId, table.baseId), "write")
  ) {
    return null;
  }
  return loadRowScope(db, { userId, bindings }, table);
}

/** Template values: every column as display text, plus the run's own keys. */
export function templateValues(
  engine: EngineCatalog,
  row: RowRecord | null,
  people: ReadonlyMap<string, string>,
  extra: { table: string; recordUrl: string },
): Record<string, string> {
  const values: Record<string, string> = {
    table: extra.table,
    now: new Date().toISOString(),
    record_id: row?.id ?? "",
    record_url: row ? extra.recordUrl : "",
  };
  if (!row) return values;
  for (const column of engine.table.columns) {
    const value = row[column.name];
    if (
      column.fieldType === "user" ||
      column.fieldType === "created_by" ||
      column.fieldType === "last_modified_by"
    ) {
      const ids = Array.isArray(value) ? value : value ? [value] : [];
      values[column.name] = ids
        .map((id) => people.get(String(id)) ?? "")
        .join(", ");
    } else {
      values[column.name] = cellText(value);
    }
  }
  return values;
}

/** Turns templated text into cell values; a value that does not fit fails the step. */
function coerceAll(
  engine: EngineCatalog,
  templates: Record<string, string>,
  values: Record<string, string>,
  resolveUser: (text: string) => string | undefined,
): Record<string, CellValue> {
  const columns = new Map(
    writeColumns(engine).map((column) => [column.name, column]),
  );
  const out: Record<string, CellValue> = {};
  for (const [name, template] of Object.entries(templates)) {
    const column = columns.get(name);
    if (!column) throw new AppError("unknown_column", name);
    const coerced = coerceCellValue(column, renderTemplate(template, values), {
      resolveUser,
    });
    if (coerced === undefined) throw new AppError("invalid_value", name);
    out[name] = coerced;
  }
  return out;
}

/**
 * At most RUNS_PER_MINUTE runs of one automation in the last minute,
 * counted from its run log, so every process sees the same count.
 */
async function underRateLimit(
  db: Database,
  automationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("automationRuns")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("automationId", "=", automationId)
    .where("startedAt", ">", new Date(Date.now() - 60_000))
    .executeTakeFirst();
  return (row?.count ?? 0) < RUNS_PER_MINUTE;
}

type Step = { type: string; ok: boolean; error?: string };

/** Short, displayable reason for a failed step. */
export function stepError(error: unknown): string {
  // A public error keeps its words, which the app translates from its code:
  // a client's database refusing a value, a locked row, a missing field.
  if (error instanceof AppError && error.code !== "internal_error") {
    return error.message.slice(0, 200);
  }
  if (error instanceof Error) {
    if (/^(Unknown column|Invalid value): /.test(error.message))
      return error.message.slice(0, 120);
    if (
      [
        "Row locked",
        "Reason required",
        "No row",
        "Invalid automation",
        "Access denied",
      ].includes(error.message)
    ) {
      return error.message;
    }
    if (error.message === "Invalid webhook") return "Invalid email settings";
  }
  return failureText(error);
}

/**
 * Runs the actions of one automation in order, as its creator, and logs
 * the run. The first failing action stops the run. Writes it makes are
 * audited with source `automation:<id>` and may trigger other automations,
 * one level deeper each time, up to the depth limit.
 */
export async function runAutomation(
  deps: AutomationDeps,
  automation: AutomationRow,
  context: {
    rowId?: string;
    depth: number;
    trigger: string;
    triggeredBy?: string;
    /** A row deleted: it is not read; the trail's entry gives its values. */
    deleted?: { auditId?: string };
    /** Template values of their own: a webhook call's body. */
    extra?: Readonly<Record<string, string>>;
  },
): Promise<{ status: "success" | "failed" | "skipped"; error?: string }> {
  const parsed = parseStored(automation);
  const log = async (
    status: "success" | "failed" | "skipped",
    steps: Step[],
    error?: string,
  ) => {
    await deps.db
      .insertInto("automationRuns")
      .values({
        automationId: automation.id,
        rowId: context.rowId ?? null,
        trigger: context.trigger,
        status,
        steps,
        error: error ?? null,
        depth: context.depth,
        triggeredBy: context.triggeredBy ?? null,
        finishedAt: new Date(),
      })
      .execute();
    await deps.db
      .updateTable("automations")
      .set({ lastRunAt: new Date() })
      .where("id", "=", automation.id)
      .execute();
    return { status, error };
  };
  if (!parsed) return log("failed", [], "Invalid automation");
  if (context.depth >= MAX_EVENT_DEPTH) return log("skipped", [], "Loop limit");
  if (!(await underRateLimit(deps.db, automation.id))) {
    return log("skipped", [], "Rate limit");
  }
  if (!automation.createdBy) return log("failed", [], "Access denied");
  const creatorId = automation.createdBy;
  const own = await creatorEngine(deps.db, creatorId, automation.tableId);
  if (!own) return log("failed", [], "Access denied");
  let row: RowRecord | null = null;
  if (context.rowId && !context.deleted) {
    const page = await readPage(
      deps.db,
      own.engine,
      { rowIds: [context.rowId], limit: 1, timeZone: "UTC", me: creatorId },
      { total: false },
    );
    row = page.rows[0] ?? null;
    if (!row) return log("skipped", [], "No row");
  }
  const collaborators = await listCollaborators(deps.db, own.table.baseId);
  const people = new Map(
    collaborators.map((person) => [person.id, person.displayName]),
  );
  const resolveUser = (text: string) => {
    const folded = text.trim().toLowerCase();
    return collaborators.find(
      (person) => person.displayName.toLowerCase() === folded,
    )?.id;
  };
  const values = {
    ...templateValues(own.engine, row, people, {
      table: own.table.name,
      recordUrl: `${deps.webOrigin}/b/${own.table.baseId}/t/${own.table.id}?row=${context.rowId ?? ""}`,
    }),
    ...(context.deleted
      ? {
          record_id: context.rowId ?? "",
          ...(await deletedValues(
            deps.db,
            own.engine,
            context.deleted.auditId,
          )),
        }
      : {}),
    ...(context.extra ?? {}),
  };
  const source = `automation:${automation.id}`;
  // No one asked in a language: the instance's default names it.
  const reason = (await madeNamesFor(deps.db))
    .automation(automation.name)
    .slice(0, 500);
  const rowDeps: RowServiceDeps = {
    db: deps.db,
    bus: deps.bus,
    log: deps.log,
  };
  /** What a step runs in: the table it writes, its row, its values. */
  type Frame = {
    scope: RowScope;
    row: RowRecord | null;
    values: Record<string, string>;
  };
  const steps: Step[] = [];
  /** One action that holds no other; throws what fails. */
  const runStep = async (action: AutomationStep, frame: Frame) => {
    switch (action.type) {
      case "update_record": {
        if (!frame.row) throw new AppError("no_row");
        const cells = coerceAll(
          frame.scope.engine,
          action.values,
          frame.values,
          resolveUser,
        );
        // The automation writes as its author, within their field and row rules.
        await updateRows(
          rowDeps,
          frame.scope,
          [{ rowId: frame.row.id, values: cells }],
          // Every automation write is audited with the automation's name.
          { fixedReason: reason, source, depth: context.depth + 1 },
        );
        break;
      }
      case "create_record": {
        const target = await creatorEngine(deps.db, creatorId, action.tableId);
        if (!target || target.table.baseId !== own.table.baseId) {
          throw new AppError("access_denied");
        }
        const cells = coerceAll(
          target.engine,
          action.values,
          frame.values,
          resolveUser,
        );
        await createRows(rowDeps, target, [{ values: cells }], {
          fixedReason: reason,
          source,
          depth: context.depth + 1,
        });
        break;
      }
      case "send_email": {
        const recipients = renderTemplate(action.to, frame.values)
          .split(/[,;\s]+/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (
          recipients.length === 0 ||
          recipients.length > MAX_EMAIL_RECIPIENTS ||
          recipients.some((item) => !isEmail(item))
        ) {
          throw new AppError("invalid_value", "to");
        }
        // The author's own text: sent under the instance's name, and left
        // as written, without its signature.
        const { sender } = await readMailVoice(deps.db);
        await sendMail(
          deps.smtp,
          { sender, signature: null },
          {
            to: recipients.join(", "),
            subject: renderTemplate(action.subject, frame.values)
              .replace(/[\r\n]+/g, " ")
              .slice(0, 200),
            text: renderTemplate(action.body, frame.values),
          },
        );
        break;
      }
      case "call_webhook": {
        const body =
          action.body !== undefined
            ? renderTemplate(action.body, frame.values)
            : JSON.stringify({
                automation: { id: automation.id, name: automation.name },
                table: {
                  id: frame.scope.table.id,
                  name: frame.scope.table.name,
                },
                row: frame.row
                  ? { id: frame.row.id, fields: frame.values }
                  : null,
              });
        const json = (() => {
          try {
            JSON.parse(body);
            return true;
          } catch {
            return false;
          }
        })();
        const status = await postPinned(action.url, body, {
          "content-type": json
            ? "application/json"
            : "text/plain; charset=utf-8",
          "user-agent": "AnyGridDB-Automation/1",
          "x-anygrid-automation": automation.id,
        });
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
        break;
      }
      case "notify": {
        const notifyDeps: NotifyDeps = deps;
        await notify(
          notifyDeps,
          action.users.map((userId) => ({
            userId,
            kind: "automation" as const,
            actorId: null,
            tableId: frame.scope.table.id,
            rowId: frame.row?.id ?? null,
            data: {
              automationId: automation.id,
              name: automation.name,
              message: renderTemplate(action.message, frame.values).slice(
                0,
                300,
              ),
            },
          })),
        );
        break;
      }
      case "delete_record": {
        if (!frame.row) throw new AppError("no_row");
        await deleteRows(rowDeps, frame.scope, [frame.row.id], {
          fixedReason: reason,
          source,
          depth: context.depth + 1,
        });
        break;
      }
    }
  };
  /** A list of actions; false once one failed, which stops the run. */
  const runSteps = async (
    list: readonly AutomationStep[],
    frame: Frame,
    path: string,
  ): Promise<string | null> => {
    for (const [index, action] of list.entries()) {
      const type = `${path}${String(index + 1)}.${action.type}`;
      try {
        await runStep(action, frame);
        steps.push({ type, ok: true });
      } catch (error) {
        const message = stepError(error);
        steps.push({ type, ok: false, error: message });
        return message;
      }
    }
    return null;
  };
  const top: Frame = { scope: own, row, values };
  for (const [index, action] of parsed.actions.entries()) {
    const path = String(index + 1);
    if (action.type === "branch") {
      // The condition reads the row where it lives, as a filter does.
      let taken: readonly AutomationStep[];
      try {
        if (!row) throw new AppError("no_row");
        const page = await readPage(
          deps.db,
          own.engine,
          {
            rowIds: [row.id],
            filter: action.when,
            limit: 1,
            timeZone: "UTC",
            me: creatorId,
          },
          { total: false },
        );
        const matches = page.rows.length > 0;
        taken = matches ? action.then : (action.otherwise ?? []);
        steps.push({
          type: `${path}.branch:${matches ? "then" : "otherwise"}`,
          ok: true,
        });
      } catch (error) {
        const message = stepError(error);
        steps.push({ type: `${path}.branch`, ok: false, error: message });
        return log("failed", steps, message);
      }
      const failed = await runSteps(taken, top, `${path}.`);
      if (failed) return log("failed", steps, failed);
      continue;
    }
    if (action.type === "for_each") {
      let target: RowScope | null;
      let rows: RowRecord[];
      try {
        target = await creatorEngine(deps.db, creatorId, action.tableId);
        if (!target || target.table.baseId !== own.table.baseId) {
          throw new AppError("access_denied");
        }
        const page = await readPage(
          deps.db,
          target.engine,
          {
            ...(action.filter ? { filter: action.filter } : {}),
            limit: Math.min(action.limit, MAX_LOOP_ROWS),
            timeZone: "UTC",
            me: creatorId,
          },
          { total: false },
        );
        rows = page.rows;
        steps.push({
          type: `${path}.for_each:${String(rows.length)}`,
          ok: true,
        });
      } catch (error) {
        const message = stepError(error);
        steps.push({ type: `${path}.for_each`, ok: false, error: message });
        return log("failed", steps, message);
      }
      const scope = target;
      for (const [place, item] of rows.entries()) {
        // Each action is about the loop's row; the trigger's own keys stay.
        const frame: Frame = {
          scope,
          row: item,
          values: {
            ...values,
            ...templateValues(scope.engine, item, people, {
              table: scope.table.name,
              recordUrl: `${deps.webOrigin}/b/${scope.table.baseId}/t/${scope.table.id}?row=${encodeURIComponent(item.id)}`,
            }),
          },
        };
        const failed = await runSteps(
          action.actions,
          frame,
          `${path}[${String(place + 1)}].`,
        );
        if (failed) return log("failed", steps, failed);
      }
      continue;
    }
    const failed = await runSteps([action], top, "");
    if (failed) return log("failed", steps, failed);
  }
  return log("success", steps);
}

/**
 * A deleted row's values as the trail kept them (`old_value`), by field,
 * as text: a row of AnyGridDB's own tables. A client's row gives none.
 */
async function deletedValues(
  db: Database,
  engine: EngineCatalog,
  auditId: string | undefined,
): Promise<Record<string, string>> {
  if (!auditId || engine.table.external) return {};
  const entry = await db
    .selectFrom("auditEvents")
    .select("oldValue")
    .where("id", "=", auditId)
    .executeTakeFirst();
  const old = entry?.oldValue;
  if (!old || typeof old !== "object") return {};
  const before = old as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const column of engine.table.columns) {
    if (column.name in before)
      values[column.name] = cellText(before[column.name]);
  }
  return values;
}

/** Whether a row is inside the automation's filter, read with the creator's rights. */
async function rowMatches(
  deps: AutomationDeps,
  automation: AutomationRow,
  trigger: Extract<AutomationTrigger, { type: "enters_filter" }>,
  rowId: string,
): Promise<boolean> {
  if (!automation.createdBy) return false;
  const own = await creatorEngine(
    deps.db,
    automation.createdBy,
    automation.tableId,
  );
  if (!own) return false;
  const page = await readPage(
    deps.db,
    own.engine,
    {
      rowIds: [rowId],
      filter: trigger.filter,
      limit: 1,
      timeZone: "UTC",
      me: automation.createdBy,
    },
    { total: false },
  );
  return page.rows.length > 0;
}

/**
 * Decides which automations a row event triggers, and queues one run for
 * each. The filter state and the queued runs commit together, so an event
 * handled twice never runs an automation twice.
 */
export async function handleAutomationEvent(
  deps: AutomationDeps,
  event: RowEvent,
): Promise<void> {
  const rowId = event.rowId;
  if (!rowId) return;
  const depth = event.depth ?? 0;
  await deps.db.transaction().execute(async (tx) => {
    const fired = await matchAutomations(deps, tx, { ...event, rowId });
    for (const automationId of fired) {
      await addJob(
        tx,
        TASKS.automationRun,
        { automationId, event: { ...event, depth } },
        // Actions send mail and call URLs: a run is never repeated.
        { maxAttempts: 1 },
      );
    }
  });
}

/**
 * One queued run of one automation: for one row event, or for a call to
 * its webhook (`values`, its body's fields).
 */
export async function runQueuedAutomation(
  deps: AutomationDeps,
  input: {
    automationId: string;
    event?: RowEvent;
    values?: Record<string, string>;
  },
): Promise<void> {
  const automation = await deps.db
    .selectFrom("automations")
    .selectAll()
    .where("id", "=", input.automationId)
    .where("enabled", "=", true)
    .executeTakeFirst();
  if (!automation) return;
  const parsed = parseStored(automation);
  const event = input.event;
  await runAutomation(deps, automation, {
    ...(event?.rowId ? { rowId: event.rowId } : {}),
    depth: event?.depth ?? 0,
    trigger: parsed?.trigger.type ?? "row",
    ...(event?.actorId ? { triggeredBy: event.actorId } : {}),
    ...(parsed?.trigger.type === "row_deleted"
      ? { deleted: event?.auditId ? { auditId: event.auditId } : {} }
      : {}),
    ...(input.values ? { extra: input.values } : {}),
  });
}

/** The enabled automations of the event's table that it triggers. */
async function matchAutomations(
  deps: AutomationDeps,
  tx: AuditTx,
  event: RowEvent & { rowId: string },
): Promise<string[]> {
  const fired: string[] = [];
  const list = await deps.db
    .selectFrom("automations")
    .selectAll()
    .where("tableId", "=", event.tableId)
    .where("enabled", "=", true)
    .execute();
  for (const automation of list) {
    // An automation never reacts to its own writes.
    if (event.source === `automation:${automation.id}`) continue;
    const parsed = parseStored(automation);
    if (!parsed) continue;
    const trigger = parsed.trigger;
    let fire = false;
    switch (trigger.type) {
      case "row_created":
        fire = event.event === "insert";
        break;
      case "row_updated":
        fire =
          event.event === "update" &&
          touchesWatched(trigger.columns, event.columns);
        break;
      case "form_submitted": {
        if (event.event !== "insert" || !event.source?.startsWith("form:"))
          break;
        if (!trigger.viewId) {
          fire = true;
          break;
        }
        const share = await deps.db
          .selectFrom("shares")
          .select("viewId")
          .where("id", "=", event.source.slice("form:".length))
          .executeTakeFirst();
        fire = share?.viewId === trigger.viewId;
        break;
      }
      case "enters_filter": {
        if (event.event === "delete") {
          await tx
            .deleteFrom("automationMatches")
            .where("automationId", "=", automation.id)
            .where("rowId", "=", event.rowId)
            .execute();
          break;
        }
        if (!["insert", "update", "status"].includes(event.event)) break;
        const inside = await rowMatches(deps, automation, trigger, event.rowId);
        if (!inside) {
          await tx
            .deleteFrom("automationMatches")
            .where("automationId", "=", automation.id)
            .where("rowId", "=", event.rowId)
            .execute();
          break;
        }
        const added = await tx
          .insertInto("automationMatches")
          .values({ automationId: automation.id, rowId: event.rowId })
          .onConflict((conflict) => conflict.doNothing())
          .returning("rowId")
          .execute();
        fire = added.length > 0;
        break;
      }
      case "row_deleted":
        fire = event.event === "delete";
        break;
      case "schedule":
      case "button":
      case "webhook":
        break;
    }
    if (fire) fired.push(automation.id);
  }
  return fired;
}

/** Runs scheduled automations that are due; each is claimed by moving its next run first. */
export async function runDueSchedules(deps: AutomationDeps): Promise<number> {
  const due = await deps.db.transaction().execute(async (tx) => {
    const rows = await tx
      .selectFrom("automations")
      .selectAll()
      .where("enabled", "=", true)
      .where("nextRunAt", "is not", null)
      .where("nextRunAt", "<=", new Date())
      // Schedules of a table in the trash wait for it to come back.
      .where("tableId", "in", (eb) =>
        eb
          .selectFrom("dataTables as t")
          .innerJoin("bases as b", "b.id", "t.baseId")
          .select("t.id")
          .where(liveTable("t"))
          .where(liveBase("b")),
      )
      .limit(20)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const row of rows) {
      const parsed = parseStored(row);
      await tx
        .updateTable("automations")
        .set({
          nextRunAt:
            parsed?.trigger.type === "schedule"
              ? nextScheduleRun(parsed.trigger, new Date())
              : null,
        })
        .where("id", "=", row.id)
        .execute();
    }
    return rows;
  });
  for (const automation of due) {
    try {
      await runAutomation(deps, automation, { depth: 0, trigger: "schedule" });
    } catch (error) {
      deps.log(error, "scheduled automation failed");
    }
  }
  return due.length;
}

/**
 * Runs the automations behind a button cell. The clicking user must be
 * able to write the table; each automation still acts as its creator.
 */
export async function pressButton(
  deps: AutomationDeps,
  input: { userId: string; table: TableRow; rowId: string; column: string },
): Promise<
  Array<{ status: "success" | "failed" | "skipped"; error?: string }>
> {
  const list = await deps.db
    .selectFrom("automations")
    .selectAll()
    .where("tableId", "=", input.table.id)
    .where("enabled", "=", true)
    .execute();
  const linked = list.filter((automation) => {
    const parsed = parseStored(automation);
    return (
      parsed?.trigger.type === "button" &&
      parsed.trigger.column === input.column
    );
  });
  if (linked.length === 0) {
    throw new AppError("invalid_automation");
  }
  const results = [];
  for (const automation of linked) {
    // One press per row every two seconds, so a double click runs once.
    const lock = await acquireLock(deps.db, {
      key: `button:${automation.id}:${input.rowId}`,
      owner: randomUUID(),
      ttlSeconds: 2,
    });
    if (!lock) {
      results.push({ status: "skipped" as const, error: "Rate limit" });
      continue;
    }
    results.push(
      await runAutomation(deps, automation, {
        rowId: input.rowId,
        depth: 0,
        trigger: "button",
        triggeredBy: input.userId,
      }),
    );
  }
  return results;
}

export async function purgeRuns(db: Database): Promise<void> {
  await db
    .deleteFrom("automationRuns")
    .where(
      "startedAt",
      "<",
      new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    )
    .execute();
}
