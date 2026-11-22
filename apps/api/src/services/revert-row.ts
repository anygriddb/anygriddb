/**
 * Puts a row, or one of its fields, back to an earlier write (ADR 0089).
 * The earlier value is read from the trail. The write is the ordinary one.
 */
import {
  AppError,
  type CellValue,
  cellFromAudit,
  isDecimalString,
  isWritableType,
  withExactNumbers,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { assertAttachmentKeys } from "../attachments.js";
import { readByIds, trailNumbers } from "../data/rows.js";
import type { RowScope, RowServiceDeps } from "./rows.js";
import { replaceLinks, updateRows } from "./rows.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Seen = Record<string, unknown>;

export async function revertRow(
  deps: RowServiceDeps,
  scope: RowScope,
  input: {
    recordId: string;
    eventId: string;
    field?: string;
    seen: Seen;
    reason?: string;
  },
): Promise<void> {
  const external = scope.table.storage === "external";
  const past = external
    ? await externalPast(deps.db, scope.table.id, input.recordId, input.eventId)
    : await nativePast(deps.db, scope.table.id, input.recordId, input.eventId);
  const fields = fieldsOf(scope, past, input.field);
  if (fields.length === 0) throw new AppError("revert_unavailable");
  const values: Record<string, ReturnType<typeof cellFromAudit>> = {};
  const links: Array<{ column: string; targetIds: string[] }> = [];
  for (const field of fields) {
    if (field === "ag_updated_at") continue;
    const column = scope.engine.table.columns.find(
      (item) => item.name === field,
    );
    if (!column) throw new AppError("revert_unavailable");
    const raw = past[field];
    if (isDirectLink(column)) {
      links.push({ column: field, targetIds: linkIds(raw) });
      continue;
    }
    if (!isWritableType(column.fieldType))
      throw new AppError("revert_unavailable");
    const cell = cellFromAudit(column.fieldType, raw ?? null);
    // Never a rounded value: what a write cannot hold is not put back.
    if (
      column.fieldType === "number" &&
      typeof cell === "string" &&
      !isDecimalString(cell)
    ) {
      throw new AppError("revert_not_exact", field);
    }
    values[field] = cell;
  }
  if (input.field) {
    if (!Object.hasOwn(input.seen, input.field)) {
      throw new AppError("revert_stale");
    }
  } else if (external) {
    for (const field of Object.keys(values)) {
      if (!Object.hasOwn(input.seen, field)) throw new AppError("revert_stale");
    }
  } else if (!Object.hasOwn(input.seen, "ag_updated_at")) {
    throw new AppError("revert_stale");
  }
  await assertFiles(deps.db, scope, values);
  const meta = {
    source: "revert",
    ...(input.reason ? { reason: input.reason } : {}),
  };
  if (Object.keys(values).length > 0) {
    // What the screen showed, for the fields written here alone: none of
    // them is hidden from this writer (`fieldsOf`).
    const seen: Record<string, unknown> = {};
    if (external || input.field) {
      for (const field of Object.keys(values)) {
        seen[field] = input.seen[field];
      }
    } else {
      seen.ag_updated_at = input.seen.ag_updated_at;
    }
    try {
      await updateRows(
        deps,
        scope,
        [
          external
            ? {
                rowId: input.recordId,
                values,
                // Compared by the client's table as any of its writes is.
                expected: seen as Readonly<Record<string, CellValue>>,
              }
            : { rowId: input.recordId, values, storedNow: seen },
        ],
        meta,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "source_conflict") {
        throw new AppError("revert_stale", { cause: error });
      }
      if (error instanceof AppError && error.code === "invalid_attachment") {
        throw new AppError("revert_file_gone", { cause: error });
      }
      throw error;
    }
  }
  if (!external && links.length > 0) {
    const [current] = await readByIds(
      deps.db,
      scope.engine,
      [input.recordId],
      "UTC",
    );
    if (!current) throw new AppError("no_row");
    for (const link of links) {
      if (!Object.hasOwn(input.seen, link.column)) {
        throw new AppError("revert_stale");
      }
      const seen = linkIds(input.seen[link.column]);
      const now = linkIds(current[link.column]);
      if (!sameIds(seen, now)) throw new AppError("revert_stale");
      if (sameIds(link.targetIds, now)) continue;
      await replaceLinks(deps, scope, input.recordId, link, meta);
    }
  }
}

function fieldsOf(
  scope: RowScope,
  past: Record<string, unknown>,
  field: string | undefined,
): string[] {
  if (field) {
    if (field.startsWith("ag_") || !Object.hasOwn(past, field)) {
      throw new AppError("revert_unavailable");
    }
    if (hidden(scope, field)) throw new AppError("access_denied");
    return [field];
  }
  const names = Object.keys(past).filter(
    (name) =>
      !name.startsWith("ag_") && !hidden(scope, name) && writable(scope, name),
  );
  return names;
}

function hidden(scope: RowScope, name: string): boolean {
  const access = scope.engine.access;
  if (!access) return false;
  return (
    access.hidden(scope.table.id, name) || access.readOnly(scope.table.id, name)
  );
}

function writable(scope: RowScope, name: string): boolean {
  const column = scope.engine.table.columns.find((item) => item.name === name);
  if (!column) return false;
  if (isDirectLink(column)) return true;
  return isWritableType(column.fieldType);
}

function isDirectLink(column: {
  fieldType: string;
  relation?: { direction?: string } | null;
}): boolean {
  return (
    column.fieldType === "relation_one_to_many" &&
    column.relation?.direction !== "inverse"
  );
}

async function nativePast(
  db: Database,
  tableId: string,
  recordId: string,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (!UUID.test(recordId)) throw new AppError("revert_unavailable");
  const event = await db
    .selectFrom("auditEvents")
    .select(["oldValue", "action"])
    // jsonb keeps every digit of a number; its JSON read here does not.
    .select(trailNumbers(sql.ref("old_value")).as("oldNumbers"))
    .where("id", "=", eventId)
    .where("tableId", "=", tableId)
    .where("recordId", "=", recordId)
    .executeTakeFirst();
  if (!event || event.action !== "update")
    throw new AppError("revert_unavailable");
  return object(withExactNumbers(event.oldValue, event.oldNumbers));
}

async function externalPast(
  db: Database,
  tableId: string,
  recordId: string,
  eventId: string,
): Promise<Record<string, unknown>> {
  const write = await db
    .selectFrom("externalWrites")
    .select(["id", "action", "oldValue", "rowId"])
    .where("id", "=", eventId)
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  if (!write || write.action !== "update" || write.rowId !== recordId) {
    throw new AppError("revert_unavailable");
  }
  const steps = await db
    .selectFrom("externalWriteSteps")
    .select("step")
    .where("writeId", "=", write.id)
    .execute();
  const done = new Set(steps.map((step) => step.step));
  if (
    done.has("abandoned") ||
    (!done.has("applied") && !done.has("confirmed"))
  ) {
    throw new AppError("revert_unavailable");
  }
  return object(write.oldValue);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("revert_unavailable");
  }
  return value as Record<string, unknown>;
}

function linkIds(value: unknown): string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "id" in item) {
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    }
    return [];
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

async function assertFiles(
  db: Database,
  scope: RowScope,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const names = scope.engine.table.columns
    .filter((column) => column.fieldType === "attachment")
    .map((column) => column.name);
  const keys = names.flatMap((name) => {
    const value = values[name];
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  });
  if (keys.length === 0) return;
  try {
    await assertAttachmentKeys(db, scope.table.id, keys);
  } catch (error) {
    if (error instanceof AppError && error.code === "invalid_attachment") {
      throw new AppError("revert_file_gone", { cause: error });
    }
    throw error;
  }
}
