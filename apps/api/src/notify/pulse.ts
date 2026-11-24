import { randomUUID } from "node:crypto";
import { heartbeatSecretsSchema, trimEndRun } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret } from "../auth/crypto.js";
import {
  notifyFailureText,
  sendOutbound,
  type Outbound,
  type OutboundResponse,
} from "./outbound.js";
import { readSettings } from "../settings.js";

export type PulsePhase = "start" | "success" | "fail";

type Secrets = {
  pingUrl?: string;
  pushUrl?: string;
  startUrl?: string;
  successUrl?: string;
  failUrl?: string;
};

export function heartbeatTarget(
  provider: string,
  secrets: Secrets,
  phase: PulsePhase,
): string | null {
  if (provider === "healthchecks" && secrets.pingUrl) {
    const base = trimEndRun(secrets.pingUrl, "/");
    if (phase === "start") return `${base}/start`;
    if (phase === "fail") return `${base}/fail`;
    return base;
  }
  if (provider === "uptime-kuma" && secrets.pushUrl) {
    const url = new URL(secrets.pushUrl);
    url.searchParams.set("status", phase === "fail" ? "down" : "up");
    url.searchParams.set("msg", phase === "fail" ? "failed" : "ok");
    return url.href;
  }
  if (provider === "heartbeat") {
    if (phase === "start") return secrets.startUrl ?? null;
    if (phase === "fail") return secrets.failUrl ?? null;
    return secrets.successUrl ?? null;
  }
  return null;
}

export function heartbeatAccepted(
  provider: string,
  response: OutboundResponse,
): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  if (provider === "healthchecks" && /not found/i.test(response.body))
    return false;
  return true;
}

/**
 * Tells the monitors bound to this schedule. A failure here is recorded
 * and does not fail the job that just ran.
 */
export async function pulse(
  deps: {
    db: Database;
    key: KeyRing;
    log: (error: unknown, message: string) => void;
    send?: Outbound;
  },
  schedule: string,
  phase: PulsePhase,
): Promise<void> {
  const rows = await deps.db
    .selectFrom("integrationSchedules as s")
    .innerJoin("instanceIntegrations as i", "i.id", "s.integrationId")
    .select([
      "i.id",
      "i.provider",
      "i.secretsCiphertext",
      "i.secretsNonce",
      "i.enabled",
      "i.status",
    ])
    .where("s.schedule", "=", schedule)
    .where("i.enabled", "=", true)
    .where("i.status", "=", "active")
    .execute();
  if (rows.length === 0) return;
  const allowPrivate = (await readSettings(deps.db)).notifyAllowPrivate;
  const send = deps.send ?? sendOutbound;
  for (const row of rows) {
    let failure: string | null = null;
    let status: number | null = null;
    try {
      if (!row.secretsCiphertext || !row.secretsNonce) {
        failure = "Network error";
      } else {
        const secrets = heartbeatSecretsSchema.parse(
          JSON.parse(
            decryptSecret(
              row.secretsCiphertext,
              row.secretsNonce,
              deps.key,
              "notify",
            ),
          ),
        );
        const url = heartbeatTarget(row.provider, secrets, phase);
        if (!url) continue;
        const response = await send({ url, method: "GET" }, allowPrivate);
        status = response.status;
        if (!heartbeatAccepted(row.provider, response))
          failure = `HTTP ${String(response.status)}`;
      }
    } catch (error) {
      failure = notifyFailureText(error);
      deps.log(error, "heartbeat failed");
    }
    await deps.db
      .insertInto("integrationDeliveries")
      .values({
        integrationId: row.id,
        eventId: randomUUID(),
        event: `heartbeat.${phase}`,
        subject: schedule,
        status: failure ? "failed" : "success",
        attempts: 1,
        responseStatus: status,
        error: failure?.slice(0, 200) ?? null,
        finishedAt: new Date(),
      })
      .execute();
  }
}
