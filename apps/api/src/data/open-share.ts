/**
 * A public link opened as its creator: what it shows, what it may write,
 * under the creator's role and their field and row rules. Its tRPC
 * procedures and its form's file uploads open it the same way.
 */
import type { KeyRing } from "../auth/key-ring.js";
import {
  AppError,
  effectiveTableRole,
  formWindow,
  LINK_PERMISSIONS,
  normalizeViewConfig,
  roleGrants,
  roleFor,
  type ViewConfig,
  withRequiredFormFields,
} from "@anygriddb/core";
import { granted } from "../access/declaration.js";
import type { Database } from "@anygriddb/db";
import { authorBindings } from "../auth/access.js";
import { readerEngine } from "./acl.js";
import { liveTable } from "./live.js";
import { writeColumns } from "./rows.js";
import { resolveBaseShare, resolveShare } from "./sharing.js";

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
  permission: "rows.read" | "rows.write",
) {
  const resolved = await resolveShare(deps.db, deps.encryptionKey, input);
  // A link acts as its creator, as they are now: it stops while they may
  // no longer make it (a view's shows rows, an export), and comes back
  // if they may again.
  const bindings = await authorBindings(deps.db, resolved.share.createdBy);
  const role = effectiveTableRole(
    bindings,
    resolved.table.id,
    resolved.table.baseId,
  );
  const kind = resolved.view.viewType === "form" ? "form" : "view";
  if (
    !granted(role, permission) ||
    !LINK_PERMISSIONS[kind].every((asked) => granted(role, asked))
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
 * table AnyGridDB stores, open and within the time it takes answers,
 * showing that attachment field, which its creator may write.
 */
export function acceptsFormFile(opened: OpenedShare, field: string): boolean {
  if (
    opened.locked ||
    opened.view.viewType !== "form" ||
    opened.table.storage === "external" ||
    !opened.fields.includes(field) ||
    // A form that takes no answers now takes no file either.
    formWindow(opened.config.form) !== "open"
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

/**
 * A link to a whole base, opened as its creator (ROADMAP row 93): it
 * stops when they no longer read the base. `tables` are the base's own
 * tables they may read, in the sidebar's order; `read` gives one of them
 * as they read it, under their field and row rules, and the fields they
 * see of it.
 */
export async function openBaseShare(
  deps: { db: Database; encryptionKey: KeyRing },
  input: { token: string; password?: string; access?: string },
) {
  const resolved = await resolveBaseShare(deps.db, deps.encryptionKey, input);
  const reader = {
    userId: resolved.share.createdBy,
    bindings: await authorBindings(deps.db, resolved.share.createdBy),
  };
  const held = roleFor(reader.bindings, "base", resolved.base.id);
  if (
    !granted(held, "rows.read") ||
    !LINK_PERMISSIONS.base.every((asked) => granted(held, asked))
  ) {
    throw new AppError("unknown_share");
  }
  const tables = (
    await deps.db
      .selectFrom("dataTables")
      .select(["id", "name", "baseId"])
      .where("baseId", "=", resolved.base.id)
      .where("storage", "=", "native")
      .where(liveTable())
      .orderBy("position", "asc")
      .orderBy("createdAt", "asc")
      .execute()
  ).filter((table) =>
    roleGrants(
      effectiveTableRole(reader.bindings, table.id, table.baseId),
      "rows.read",
    ),
  );
  const read = async (tableId: string) => {
    if (!tables.some((table) => table.id === tableId)) {
      throw new AppError("unknown_share");
    }
    const loaded = await readerEngine(deps.db, tableId, reader);
    const engine = loaded.engine;
    const fields = engine.table.columns
      .filter((column) => !engine.access?.hidden(tableId, column.name))
      .map((column) => column.name);
    return { engine, rows: loaded.rows, fields };
  };
  return { ...resolved, tables, read };
}
