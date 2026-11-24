import type { KeyRing } from "./auth/key-ring.js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  effectiveTableRole,
  type EngineCatalog,
  filterGroupSchema,
  nextRetryDelay,
  roleAllows,
  type RowEvent,
  touchesWatched,
  WEBHOOK_FAILURE_LIMIT,
} from "@anygriddb/core";
import type { Database, DeliveryRow, NewRow, WebhookRow } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { loadBindings } from "./auth/access.js";
import { readerEngine } from "./data/acl.js";
import { withAudit } from "./data/audit-context.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { decryptSecret, encryptSecret } from "./auth/crypto.js";
import { loadEngine } from "./data/engine.js";
import { readPage, type RowRecord } from "./data/rows.js";
import { readMailVoice } from "./settings.js";
import {
  webhookDisabledMailBody,
  webhookDisabledMailSubject,
} from "./mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "./mail.js";
import {
  assertOutboundTarget,
  outboundFailureText,
  postOutbound,
} from "./outbound/index.js";
import type { NotificationInput } from "./notifications.js";
import { addJob, TASKS, type SqlExecutor } from "./queue/jobs.js";

/**
 * Queues the attempt that follows `attempts` earlier ones. The key names
 * that attempt, so adding it twice queues it once, and the attempt that
 * schedules the next one never collides with its own job.
 */
function queueAttempt(
  executor: SqlExecutor,
  delivery: { id: string; attempts: number },
  options: { runAt?: Date; replace?: boolean } = {},
): Promise<void> {
  return addJob(
    executor,
    TASKS.webhookAttempt,
    { deliveryId: delivery.id },
    {
      runAt: options.runAt,
      // HTTP failures follow the delivery's own schedule; these retries
      // only cover the database being unreachable.
      maxAttempts: 3,
      jobKey: `webhook:${delivery.id}:${String(delivery.attempts)}`,
      jobKeyMode: options.replace ? "replace" : "unsafe_dedupe",
    },
  );
}

const DELIVERY_RETENTION_DAYS = 30;
/** A pending delivery whose attempt is this late lost its job: queue it again. */
const STALE_ATTEMPT_MS = 15 * 60_000;

export type HookDeps = {
  db: Database;
  key: KeyRing;
  smtp: SmtpConfig;
  log: (error: unknown, message: string) => void;
  /** Tells the creator in the app when their webhook switches itself off. */
  notify?: (items: NotificationInput[]) => Promise<unknown>;
};

/* ------------------------------------------------------------------ */
/* Public targets                                                      */
/* ------------------------------------------------------------------ */

/**
 * The address a webhook, an automation's call or a collector of the
 * sign-in trail is saved with: public HTTPS, as the outbound service
 * holds every call to (ADR 0125), refused as the form's own mistake. A
 * private network never: who saves one is not an administrator.
 */
export async function assertPublicHttps(target: string): Promise<URL> {
  try {
    return await assertOutboundTarget(target, { allowPrivate: false });
  } catch (error) {
    throw new AppError("invalid_webhook", { cause: error });
  }
}

export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * A short, stable description of a failed delivery, safe to show. A
 * webhook that writes to an address fails as `invalid_webhook` only when
 * the instance has no mail server.
 */
export function failureText(error: unknown): string {
  if (error instanceof AppError && error.code === "invalid_webhook") {
    return "Invalid email settings";
  }
  return outboundFailureText(error);
}

/* ------------------------------------------------------------------ */
/* Webhook records                                                     */
/* ------------------------------------------------------------------ */

function sealHeaders(
  headers: Record<string, string> | null | undefined,
  key: KeyRing,
): { headersCiphertext: Buffer | null; headersNonce: Buffer | null } {
  if (!headers || Object.keys(headers).length === 0) {
    return { headersCiphertext: null, headersNonce: null };
  }
  const sealed = encryptSecret(JSON.stringify(headers), key, "webhook");
  return { headersCiphertext: sealed.ciphertext, headersNonce: sealed.nonce };
}

function openHeaders(hook: WebhookRow, key: KeyRing): Record<string, string> {
  if (!hook.headersCiphertext || !hook.headersNonce) return {};
  const parsed: unknown = JSON.parse(
    decryptSecret(hook.headersCiphertext, hook.headersNonce, key, "webhook"),
  );
  if (!parsed || typeof parsed !== "object") return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function createWebhook(
  db: Database,
  key: KeyRing,
  input: {
    tableId: string;
    createdBy: string;
    kind: "http" | "smtp";
    target: string;
    events: string[];
    name?: string;
    filter?: unknown;
    watchColumns?: string[];
    headers?: Record<string, string>;
    includeValues?: boolean;
  },
): Promise<{ id: string; secret: string }> {
  if (input.kind === "http") {
    await assertPublicHttps(input.target);
  }
  const secret = randomBytes(32).toString("base64url");
  const sealed = encryptSecret(secret, key, "webhook");
  const inserted = await withAudit(
    db,
    { userId: input.createdBy, tableId: input.tableId, source: "web" },
    (tx) =>
      tx
        .insertInto("webhooks")
        .values({
          tableId: input.tableId,
          kind: input.kind,
          target: input.target,
          secretCiphertext: sealed.ciphertext,
          secretNonce: sealed.nonce,
          events: input.events,
          name: input.name ?? "",
          createdBy: input.createdBy,
          filter: input.filter ?? null,
          watchColumns: input.watchColumns?.length ? input.watchColumns : null,
          includeValues: input.includeValues ?? false,
          ...sealHeaders(input.headers, key),
        })
        .returning("id")
        .executeTakeFirst(),
  );
  const id = inserted?.id;
  if (!id) {
    throw new AppError("no_row");
  }
  return { id, secret };
}

export async function updateWebhook(
  db: Database,
  key: KeyRing,
  actorId: string,
  webhookId: string,
  input: {
    active?: boolean;
    events?: string[];
    name?: string;
    filter?: unknown;
    watchColumns?: string[] | null;
    headers?: Record<string, string> | null;
    includeValues?: boolean;
    target?: string;
    source?: string;
  },
): Promise<void> {
  const patch: Partial<NewRow<"webhooks">> = {};
  if (input.active !== undefined) {
    patch.active = input.active;
    if (input.active) {
      patch.failureCount = 0;
      patch.disabledReason = null;
    }
  }
  if (input.events) patch.events = input.events;
  if (input.name !== undefined) patch.name = input.name;
  if (input.filter !== undefined) patch.filter = input.filter;
  if (input.watchColumns !== undefined) {
    patch.watchColumns = input.watchColumns?.length ? input.watchColumns : null;
  }
  if (input.headers !== undefined)
    Object.assign(patch, sealHeaders(input.headers, key));
  if (input.includeValues !== undefined)
    patch.includeValues = input.includeValues;
  if (input.target !== undefined) patch.target = input.target;
  if (Object.keys(patch).length === 0) return;
  const hook = await db
    .selectFrom("webhooks")
    .select("tableId")
    .where("id", "=", webhookId)
    .executeTakeFirst();
  if (!hook) throw new AppError("no_row");
  await withAudit(
    db,
    { userId: actorId, tableId: hook.tableId, source: input.source ?? "web" },
    (tx) =>
      tx
        .updateTable("webhooks")
        .set(patch)
        .where("id", "=", webhookId)
        .execute(),
  );
}

export async function listWebhooks(db: Database, tableId: string) {
  const rows = await db
    .selectFrom("webhooks as w")
    .leftJoin("users as u", "u.id", "w.createdBy")
    .select([
      "w.id",
      "w.name",
      "w.kind",
      "w.target",
      "w.events",
      "w.filter",
      "w.watchColumns",
      "w.includeValues",
      sqlTag<boolean>`w.headers_ciphertext is not null`.as("hasHeaders"),
      "w.active",
      "w.failureCount",
      "w.disabledReason",
      "u.displayName as createdBy",
      "w.createdAt",
    ])
    .where("w.tableId", "=", tableId)
    .orderBy("w.createdAt", "asc")
    .execute();
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function webhookTableId(
  db: Database,
  webhookId: string,
): Promise<string> {
  const row = await db
    .selectFrom("webhooks")
    .select("tableId")
    .where("id", "=", webhookId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row.tableId;
}

export async function deliveryWebhookId(
  db: Database,
  deliveryId: string,
): Promise<string> {
  const row = await db
    .selectFrom("webhookDeliveries")
    .select("webhookId")
    .where("id", "=", deliveryId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row.webhookId;
}

export async function deleteWebhook(
  db: Database,
  actorId: string,
  webhookId: string,
) {
  const hook = await db
    .selectFrom("webhooks")
    .select("tableId")
    .where("id", "=", webhookId)
    .executeTakeFirst();
  if (!hook) throw new AppError("no_row");
  const deleted = await withAudit(
    db,
    { userId: actorId, tableId: hook.tableId, source: "web" },
    (tx) =>
      tx
        .deleteFrom("webhooks")
        .where("id", "=", webhookId)
        .returning("id")
        .execute(),
  );
  if (deleted.length === 0) {
    throw new AppError("no_row");
  }
}

export async function listDeliveries(
  db: Database,
  webhookId: string,
  limit: number,
) {
  const rows = await db
    .selectFrom("webhookDeliveries")
    .select([
      "id",
      "event",
      "rowId",
      "status",
      "attempts",
      "responseStatus",
      "error",
      sqlTag<boolean>`payload is not null`.as("retryable"),
      "nextAttemptAt",
      "createdAt",
      "finishedAt",
    ])
    .where("webhookId", "=", webhookId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    ...row,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

type WebhookPayload = {
  id: string;
  event: string;
  occurredAt: string;
  table: { id: string; name: string };
  rowId: string | null;
  changed: string[] | null;
  source: string | null;
  count?: number;
  row: {
    id: string;
    status: string | null;
    fields: Record<string, unknown>;
  } | null;
};

/** The row as sent: system columns out, fields keyed by column name. */
export function payloadRow(row: RowRecord): WebhookPayload["row"] {
  const fields = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== "id" && !key.startsWith("ag_"),
    ),
  );
  return {
    id: row.id,
    status: typeof row.ag_status === "string" ? row.ag_status : null,
    fields,
  };
}

/**
 * The webhook creator's view of the table, or null when they can no longer
 * read it: a webhook never sends what its creator could not see.
 */
async function creatorEngine(
  db: Database,
  userId: string,
  tableId: string,
): Promise<EngineCatalog | null> {
  const bindings = await loadBindings(db, userId);
  const loaded = await loadEngine(db, tableId, () => true);
  const table = loaded.rows.tables.find((item) => item.id === tableId);
  if (
    !table ||
    !roleAllows(effectiveTableRole(bindings, tableId, table.baseId), "read")
  ) {
    return null;
  }
  return (await readerEngine(db, tableId, { userId, bindings })).engine;
}

const ROW_EVENTS = new Set(["insert", "update", "status"]);

/** Builds the payload for one webhook, or null when its filter leaves the row out. */
async function payloadFor(
  deps: Pick<HookDeps, "db">,
  hook: WebhookRow,
  event: RowEvent,
  tableName: string,
  deliveryId: string,
): Promise<WebhookPayload | null> {
  let row: WebhookPayload["row"] = null;
  if (hook.createdBy && event.rowId && ROW_EVENTS.has(event.event)) {
    const engine = await creatorEngine(deps.db, hook.createdBy, event.tableId);
    if (!engine) return null;
    const filter = hook.filter
      ? filterGroupSchema.safeParse(hook.filter)
      : null;
    const page = await readPage(
      deps.db,
      engine,
      {
        rowIds: [event.rowId],
        filter: filter?.success ? filter.data : undefined,
        limit: 1,
        timeZone: "UTC",
        me: hook.createdBy,
      },
      { total: false },
    );
    const found = page.rows[0];
    if (!found) return null;
    if (hook.includeValues) row = payloadRow(found);
  } else if (hook.createdBy) {
    // Deletes and imports carry no values, but the creator must still read the table.
    if (!(await creatorEngine(deps.db, hook.createdBy, event.tableId)))
      return null;
  }
  return {
    id: deliveryId,
    event: event.event,
    occurredAt: event.at ?? new Date().toISOString(),
    table: { id: event.tableId, name: tableName },
    rowId: event.rowId ?? null,
    changed: event.columns ?? null,
    source: event.source ?? null,
    ...(event.count === undefined ? {} : { count: event.count }),
    row,
  };
}

async function send(
  deps: Pick<HookDeps, "db" | "key" | "smtp">,
  hook: WebhookRow,
  payload: unknown,
): Promise<number> {
  const body = JSON.stringify(payload);
  if (hook.kind === "smtp") {
    const event = (payload as { event?: unknown }).event;
    // A payload for a program to read: under the instance's name, and
    // nothing after it, so no signature.
    const voice = await readMailVoice(deps.db);
    await sendMail(
      deps.smtp,
      { sender: voice.sender, signature: null },
      {
        to: hook.target,
        subject: `${voice.name} ${String(event)}${hook.name ? ` · ${hook.name}` : ""}`,
        text: JSON.stringify(payload, null, 2),
      },
    );
    return 250;
  }
  const secret = decryptSecret(
    hook.secretCiphertext,
    hook.secretNonce,
    deps.key,
    "webhook",
  );
  const deliveryId = (payload as { id?: unknown }).id;
  const status = await postOutbound(hook.target, body, {
    ...openHeaders(hook, deps.key),
    "content-type": "application/json",
    "user-agent": "AnyGridDB-Webhook/2",
    "x-anygrid-event": String((payload as { event?: unknown }).event),
    "x-anygrid-delivery": typeof deliveryId === "string" ? deliveryId : "",
    "x-anygrid-signature": `sha256=${signBody(secret, body)}`,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  return status;
}

type AttemptPlan =
  | { status: "success"; clearPayload: true }
  | { status: "pending"; retryInSeconds: number }
  | { status: "failed" };

/** What an attempt leads to, from its outcome and the attempts made so far. */
export function planAttempt(ok: boolean, attempts: number): AttemptPlan {
  if (ok) return { status: "success", clearPayload: true };
  const delay = nextRetryDelay(attempts);
  return delay === null
    ? { status: "failed" }
    : { status: "pending", retryInSeconds: delay };
}

async function recordFailure(deps: HookDeps, hook: WebhookRow): Promise<void> {
  const updated = await deps.db
    .updateTable("webhooks")
    .set((eb) => ({ failureCount: eb("failureCount", "+", 1) }))
    .where("id", "=", hook.id)
    .returning("failureCount")
    .executeTakeFirst();
  if (!updated || updated.failureCount < WEBHOOK_FAILURE_LIMIT) return;
  // The worker disables it under the maker's name, or the tombstone.
  await withAudit(
    deps.db,
    {
      userId: hook.createdBy ?? ERASED_USER_ID,
      tableId: hook.tableId,
      source: "worker",
    },
    (tx) =>
      tx
        .updateTable("webhooks")
        .set({ active: false, disabledReason: "Too many failed deliveries" })
        .where("id", "=", hook.id)
        .where("active", "=", true)
        .execute(),
  );
  if (hook.createdBy && deps.notify) {
    // The notification also goes by email to creators who chose that.
    await deps.notify([
      {
        userId: hook.createdBy,
        kind: "webhook_disabled",
        tableId: hook.tableId,
        data: { webhookId: hook.id, name: hook.name || hook.target },
      },
    ]);
    return;
  }
  if (!hook.createdBy || !smtpReady(deps.smtp)) return;
  const creator = await deps.db
    .selectFrom("users")
    .select("email")
    .where("id", "=", hook.createdBy)
    .executeTakeFirst();
  if (!creator) return;
  const voice = await readMailVoice(deps.db);
  const webhookName = hook.name || hook.target;
  await sendMail(deps.smtp, voice, {
    to: creator.email,
    subject: webhookDisabledMailSubject(voice),
    text: webhookDisabledMailBody(voice, webhookName),
  }).catch((error: unknown) => deps.log(error, "webhook notice failed"));
}

/** Makes one attempt and records its outcome on the delivery. */
async function attemptDelivery(
  deps: HookDeps,
  hook: WebhookRow,
  delivery: Pick<DeliveryRow, "id" | "attempts" | "payload">,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const attempts = delivery.attempts + 1;
  let status: number | null;
  let error: string | null = null;
  try {
    status = await send(deps, hook, delivery.payload);
  } catch (cause) {
    error = failureText(cause);
    const match = /^HTTP (\d{3})$/.exec(error);
    status = match ? Number(match[1]) : null;
  }
  const plan = planAttempt(error === null, attempts);
  const now = new Date();
  if (plan.status === "success") {
    await deps.db
      .updateTable("webhookDeliveries")
      .set({
        status: "success",
        attempts,
        responseStatus: status,
        error: null,
        payload: null,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .where("id", "=", delivery.id)
      .execute();
    if (hook.failureCount > 0) {
      await deps.db
        .updateTable("webhooks")
        .set({ failureCount: 0 })
        .where("id", "=", hook.id)
        .execute();
    }
  } else if (plan.status === "pending") {
    const next = new Date(now.getTime() + plan.retryInSeconds * 1000);
    await deps.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("webhookDeliveries")
        .set({ attempts, responseStatus: status, error, nextAttemptAt: next })
        .where("id", "=", delivery.id)
        .execute();
      await queueAttempt(tx, { id: delivery.id, attempts }, { runAt: next });
    });
  } else {
    await deps.db
      .updateTable("webhookDeliveries")
      .set({
        status: "failed",
        attempts,
        responseStatus: status,
        error,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .where("id", "=", delivery.id)
      .execute();
    await recordFailure(deps, hook);
  }
  return { ok: error === null, status, error };
}

/** Records and sends one event to every active webhook of its table that wants it. */
export async function handleWebhookEvent(
  deps: HookDeps,
  event: RowEvent,
): Promise<void> {
  const hooks = await deps.db
    .selectFrom("webhooks")
    .selectAll()
    .where("tableId", "=", event.tableId)
    .where("active", "=", true)
    .execute();
  const wanted = hooks.filter(
    (hook) =>
      hook.events.includes(event.event) &&
      (event.event !== "update" ||
        touchesWatched(hook.watchColumns, event.columns)),
  );
  if (wanted.length === 0) return;
  const table = await deps.db
    .selectFrom("dataTables")
    .select("name")
    .where("id", "=", event.tableId)
    .executeTakeFirst();
  if (!table) return;
  const deliveries: Array<NewRow<"webhookDeliveries"> & { id: string }> = [];
  for (const hook of wanted) {
    const id = randomUUID();
    const payload = await payloadFor(deps, hook, event, table.name, id);
    if (!payload) continue;
    deliveries.push({
      id,
      webhookId: hook.id,
      event: event.event,
      rowId: event.rowId ?? null,
      payload,
      nextAttemptAt: new Date(),
    });
  }
  if (deliveries.length === 0) return;
  // The deliveries and their first attempts exist together, or not at all,
  // so a retried event never sends twice.
  await deps.db.transaction().execute(async (tx) => {
    await tx.insertInto("webhookDeliveries").values(deliveries).execute();
    for (const delivery of deliveries) {
      await queueAttempt(tx, { id: delivery.id, attempts: 0 });
    }
  });
}

/** One queued attempt: sends the delivery unless it is no longer pending. */
export async function runDeliveryAttempt(
  deps: HookDeps,
  deliveryId: string,
): Promise<void> {
  const delivery = await deps.db
    .selectFrom("webhookDeliveries")
    .selectAll()
    .where("id", "=", deliveryId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!delivery) return;
  const hook = await deps.db
    .selectFrom("webhooks")
    .selectAll()
    .where("id", "=", delivery.webhookId)
    .executeTakeFirst();
  if (!hook?.active) {
    await deps.db
      .updateTable("webhookDeliveries")
      .set({
        status: "failed",
        error: "Webhook disabled",
        nextAttemptAt: null,
        finishedAt: new Date(),
      })
      .where("id", "=", delivery.id)
      .execute();
    return;
  }
  await attemptDelivery(deps, hook, delivery);
}

/** Sends a sample event now and records it like any delivery. */
export async function testWebhook(
  deps: HookDeps,
  webhookId: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const hook = await deps.db
    .selectFrom("webhooks")
    .selectAll()
    .where("id", "=", webhookId)
    .executeTakeFirst();
  if (!hook) {
    throw new AppError("no_row");
  }
  const table = await deps.db
    .selectFrom("dataTables")
    .select("name")
    .where("id", "=", hook.tableId)
    .executeTakeFirst();
  const id = randomUUID();
  const payload: WebhookPayload = {
    id,
    event: "test",
    occurredAt: new Date().toISOString(),
    table: { id: hook.tableId, name: table?.name ?? "" },
    rowId: null,
    changed: null,
    source: "test",
    row: null,
  };
  await deps.db
    .insertInto("webhookDeliveries")
    .values({
      id,
      webhookId: hook.id,
      event: "test",
      payload,
      nextAttemptAt: new Date(),
    })
    .execute();
  // A test is a single attempt: it is never retried and never counts as a failure.
  let status: number | null;
  let error: string | null = null;
  try {
    status = await send(deps, hook, payload);
  } catch (cause) {
    error = failureText(cause);
    const match = /^HTTP (\d{3})$/.exec(error);
    status = match ? Number(match[1]) : null;
  }
  await deps.db
    .updateTable("webhookDeliveries")
    .set({
      status: error ? "failed" : "success",
      attempts: 1,
      responseStatus: status,
      error,
      payload: error ? payload : null,
      nextAttemptAt: null,
      finishedAt: new Date(),
    })
    .where("id", "=", id)
    .execute();
  return { ok: error === null, status, error };
}

/** Queues a failed delivery again, if its payload is still kept. */
export async function retryDelivery(
  db: Database,
  deliveryId: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("webhookDeliveries")
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        finishedAt: null,
      })
      .where("id", "=", deliveryId)
      .where("status", "=", "failed")
      .where("payload", "is not", null)
      .returning("id")
      .execute();
    if (updated.length === 0) {
      throw new AppError("invalid_delivery");
    }
    await queueAttempt(tx, { id: deliveryId, attempts: 0 }, { replace: true });
  });
}

/**
 * Queues again the pending deliveries whose attempt is long overdue: a job
 * lost with a crashed worker, or a delivery that predates the job queue.
 */
export async function sweepDeliveries(db: Database): Promise<number> {
  const stale = await db
    .selectFrom("webhookDeliveries")
    .select(["id", "attempts"])
    .where("status", "=", "pending")
    .where("nextAttemptAt", "<", new Date(Date.now() - STALE_ATTEMPT_MS))
    .limit(500)
    .execute();
  for (const delivery of stale) {
    await queueAttempt(db, delivery, { replace: true });
  }
  return stale.length;
}

/** Deliveries are kept 30 days, then removed with their payloads. */
export async function purgeDeliveries(db: Database): Promise<void> {
  await db
    .deleteFrom("webhookDeliveries")
    .where(
      "createdAt",
      "<",
      new Date(Date.now() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    )
    .execute();
}
