import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
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
import { decryptSecret, encryptSecret } from "./auth/crypto.js";
import { loadEngine } from "./data/engine.js";
import { readPage, type RowRecord } from "./data/rows.js";
import { readSettings } from "./settings.js";
import {
  resolveLocale,
  webhookDisabledMailBody,
  webhookDisabledMailSubject,
} from "./mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "./mail.js";
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

const REQUEST_TIMEOUT_MS = 10_000;
const DELIVERY_RETENTION_DAYS = 30;
/** A pending delivery whose attempt is this late lost its job: queue it again. */
const STALE_ATTEMPT_MS = 15 * 60_000;

export type HookDeps = {
  db: Database;
  key: Buffer;
  smtp: SmtpConfig;
  log: (error: unknown, message: string) => void;
  /** Tells the creator in the app when their webhook switches itself off. */
  notify?: (items: NotificationInput[]) => Promise<unknown>;
};

/* ------------------------------------------------------------------ */
/* Public targets                                                      */
/* ------------------------------------------------------------------ */

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("64:ff9b::", 96, "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

/** The IPv4 address inside `::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`, if any. */
function mappedIpv4(address: string): string | null {
  const match = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(address);
  if (!match?.[1]) return null;
  const rest = match[1];
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    // Node's BlockList would match an IPv4-mapped rule against every IPv4
    // address, so mapped addresses are unwrapped and checked as IPv4.
    const inner = mappedIpv4(address);
    if (inner) return blocked.check(inner, "ipv4");
  }
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** Checks scheme, credentials, and names that never point outside. */
function assertPublicUrl(target: string | URL): URL {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("invalid_webhook");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new AppError("invalid_webhook");
  }
  const family = isIP(host);
  if (family !== 0 && isBlockedAddress(host, family)) {
    throw new AppError("invalid_webhook");
  }
  return url;
}

/** Resolves the host once to refuse private targets when a webhook is saved. */
export async function assertPublicHttps(target: string): Promise<URL> {
  const url = assertPublicUrl(target);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return url;
  const addresses = await lookup(host, { all: true, order: "verbatim" });
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isBlockedAddress(entry.address, entry.family))
  ) {
    throw new AppError("invalid_webhook");
  }
  return url;
}

/**
 * DNS lookup for outgoing webhook connections. The addresses it checks are
 * the ones the socket connects to, so a name cannot resolve to a public
 * address at save time and a private one at delivery time.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, order: "verbatim" }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const list = addresses;
    if (
      list.length === 0 ||
      list.some((entry) => isBlockedAddress(entry.address, entry.family))
    ) {
      callback(
        Object.assign(new AppError("invalid_webhook"), { code: "EBLOCKED" }),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      callback(null, list);
      return;
    }
    const first = list[0];
    callback(null, first?.address ?? "", first?.family ?? 4);
  });
};

/** POSTs a body to a public HTTPS URL; resolves with the status code. */
export async function postPinned(
  target: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = assertPublicUrl(target);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        lookup: guardedLookup,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Timeout")),
      REQUEST_TIMEOUT_MS,
    );
    outgoing.on("close", () => clearTimeout(timer));
    outgoing.on("timeout", () => outgoing.destroy(new Error("Timeout")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** A short, stable description of a failed attempt, safe to show. */
export function failureText(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "Timeout") return "Timeout";
    if (error.message === "Invalid webhook") return "Blocked target";
    if (/^HTTP \d{3}$/.test(error.message)) return error.message;
    const code = (error as { code?: unknown }).code;
    if (code === "EBLOCKED") return "Blocked target";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Unknown host";
    if (code === "ECONNREFUSED") return "Connection refused";
    if (typeof code === "string" && code.startsWith("ERR_TLS"))
      return "TLS error";
    if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      return "TLS error";
    }
  }
  return "Network error";
}

/* ------------------------------------------------------------------ */
/* Webhook records                                                     */
/* ------------------------------------------------------------------ */

function sealHeaders(
  headers: Record<string, string> | null | undefined,
  key: Buffer,
): { headersCiphertext: Buffer | null; headersNonce: Buffer | null } {
  if (!headers || Object.keys(headers).length === 0) {
    return { headersCiphertext: null, headersNonce: null };
  }
  const sealed = encryptSecret(JSON.stringify(headers), key);
  return { headersCiphertext: sealed.ciphertext, headersNonce: sealed.nonce };
}

function openHeaders(hook: WebhookRow, key: Buffer): Record<string, string> {
  if (!hook.headersCiphertext || !hook.headersNonce) return {};
  const parsed: unknown = JSON.parse(
    decryptSecret(hook.headersCiphertext, hook.headersNonce, key),
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
  key: Buffer,
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
  const sealed = encryptSecret(secret, key);
  const inserted = await db
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
      includeValues: input.includeValues ?? true,
      ...sealHeaders(input.headers, key),
    })
    .returning("id")
    .executeTakeFirst();
  const id = inserted?.id;
  if (!id) {
    throw new AppError("no_row");
  }
  return { id, secret };
}

export async function updateWebhook(
  db: Database,
  key: Buffer,
  webhookId: string,
  input: {
    active?: boolean;
    events?: string[];
    name?: string;
    filter?: unknown;
    watchColumns?: string[] | null;
    headers?: Record<string, string> | null;
    includeValues?: boolean;
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
  if (Object.keys(patch).length === 0) return;
  await db
    .updateTable("webhooks")
    .set(patch)
    .where("id", "=", webhookId)
    .execute();
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

export async function deleteWebhook(db: Database, webhookId: string) {
  const deleted = await db
    .deleteFrom("webhooks")
    .where("id", "=", webhookId)
    .returning("id")
    .execute();
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

export type WebhookPayload = {
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
  deps: Pick<HookDeps, "key" | "smtp">,
  hook: WebhookRow,
  payload: unknown,
): Promise<number> {
  const body = JSON.stringify(payload);
  if (hook.kind === "smtp") {
    const event = (payload as { event?: unknown }).event;
    await sendMail(deps.smtp, {
      to: hook.target,
      subject: `AnyGridDB ${String(event)}${hook.name ? ` · ${hook.name}` : ""}`,
      text: JSON.stringify(payload, null, 2),
    });
    return 250;
  }
  const secret = decryptSecret(
    hook.secretCiphertext,
    hook.secretNonce,
    deps.key,
  );
  const deliveryId = (payload as { id?: unknown }).id;
  const status = await postPinned(hook.target, body, {
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

export type AttemptPlan =
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
  await deps.db
    .updateTable("webhooks")
    .set({ active: false, disabledReason: "Too many failed deliveries" })
    .where("id", "=", hook.id)
    .where("active", "=", true)
    .execute();
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
  const settings = await readSettings(deps.db);
  const locale = resolveLocale(null, settings.defaultLocale);
  const webhookName = hook.name || hook.target;
  await sendMail(deps.smtp, {
    to: creator.email,
    subject: webhookDisabledMailSubject(locale),
    text: webhookDisabledMailBody(locale, webhookName),
  }).catch((error: unknown) => deps.log(error, "webhook notice failed"));
}

/** Makes one attempt and records its outcome on the delivery. */
export async function attemptDelivery(
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
