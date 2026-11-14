/**
 * A public link opened as its creator: what it shows, what it may write,
 * under the creator's role and their field and row rules. Its tRPC
 * procedures and its form's file uploads open it the same way.
 */
import type { KeyRing } from "../auth/key-ring.js";
import {
  AppError,
  effectiveTableRole,
  normalizeViewConfig,
  roleAllows,
  type ViewConfig,
  withRequiredFormFields,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { loadBindings } from "../auth/access.js";
import { readerEngine } from "./acl.js";
import { writeColumns } from "./rows.js";
import { resolveShare } from "./sharing.js";

function visibleFields(
  config: ViewConfig,
  viewType: string,
  names: readonly string[],
): string[] {
  if (viewType === "form") {
    const fields = config.form?.fields;
    if (fields && fields.length > 0) {
      return fields
        .filter((field) => !field.hidden && names.includes(field.column))
        .map((field) => field.column);
    }
    return [...names];
  }
  const hidden = new Set(config.hiddenFields ?? []);
  return names.filter((name) => !hidden.has(name));
}

export async function openShare(
  deps: { db: Database; encryptionKey: KeyRing },
  input: { token: string; password?: string; access?: string },
  action: "read" | "write",
) {
  const resolved = await resolveShare(deps.db, deps.encryptionKey, input);
  const bindings = await loadBindings(deps.db, resolved.share.createdBy);
  if (
    !roleAllows(
      effectiveTableRole(bindings, resolved.table.id, resolved.table.baseId),
      action,
    )
  ) {
    throw new AppError("unknown_share");
  }
  // A share shows what its creator may read, under their field and row rules.
  const loaded = await readerEngine(deps.db, resolved.table.id, {
    userId: resolved.share.createdBy,
    bindings,
  });
  const engine = loaded.engine;
  const names = engine.table.columns
    .filter((column) => !engine.access?.hidden(engine.table.id, column.name))
    .map((column) => column.name);
  const normalized = normalizeViewConfig(
    resolved.view.config,
    resolved.view.viewType,
  );
  // A field the table requires is on every form, required, unconditioned.
  const required = loaded.rows.columns
    .filter((column) => column.tableId === engine.table.id && column.required)
    .map((column) => column.name);
  const config =
    resolved.view.viewType === "form" && required.length > 0
      ? {
          ...normalized,
          form: {
            ...normalized.form,
            fields: withRequiredFormFields(
              normalized.form?.fields,
              names,
              required,
            ),
          },
        }
      : normalized;
  const fields = visibleFields(config, resolved.view.viewType, names);
  return { ...resolved, engine, rows: loaded.rows, config, fields };
}

type OpenedShare = Awaited<ReturnType<typeof openShare>>;

/**
 * Whether a file may be sent to `field` through this link: a form of a
 * table AnyGridDB stores, open, showing that attachment field, which its
 * creator may write.
 */
export function acceptsFormFile(opened: OpenedShare, field: string): boolean {
  if (
    opened.locked ||
    opened.view.viewType !== "form" ||
    opened.table.storage === "external" ||
    !opened.fields.includes(field)
  ) {
    return false;
  }
  const column = writeColumns(opened.engine).find(
    (item) => item.name === field,
  );
  return (
    column?.fieldType === "attachment" &&
    !opened.engine.access?.readOnly(opened.engine.table.id, field)
  );
}
