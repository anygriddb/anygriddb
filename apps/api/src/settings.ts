/**
 * The instance settings administrators change (Administration > Settings
 * and Security), stored one key per row. A missing key takes its default.
 */
import {
  acceptedLocale,
  type InstanceSettings,
  type InstanceSettingsPatch,
  madeNames,
  type MadeNames,
  parseInstanceSettings,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { recordAuthEvent } from "./auth/auth-events.js";
import { mailVoice, type MailLocale, type MailVoice } from "./mail-i18n.js";

export async function readSettings(db: Database): Promise<InstanceSettings> {
  const rows = await db.selectFrom("instanceSettings").selectAll().execute();
  return parseInstanceSettings(
    Object.fromEntries(rows.map((row) => [row.key, row.value])),
  );
}

/**
 * The instance's voice in a mail, from its settings as they are now: for a
 * reader whose language is known, or in the instance's default.
 */
export async function readMailVoice(
  db: Database,
  preference?: MailLocale | null,
): Promise<MailVoice> {
  return mailVoice(await readSettings(db), preference);
}

/**
 * The settings every request's gates read (maintenance, second factor,
 * sessions, tokens), cached a few seconds. A write here clears the cache
 * at once; another process sees it within the TTL.
 */
const GATE_TTL_MS = 5_000;
const gateCache = new WeakMap<
  Database,
  { at: number; value: Promise<InstanceSettings> }
>();

export function readGateSettings(db: Database): Promise<InstanceSettings> {
  const now = Date.now();
  const cached = gateCache.get(db);
  if (cached && now - cached.at <= GATE_TTL_MS) return cached.value;
  const value = readSettings(db);
  gateCache.set(db, { at: now, value });
  // A failed read is not kept.
  value.catch(() => {
    if (gateCache.get(db)?.value === value) gateCache.delete(db);
  });
  return value;
}

/**
 * The names AnyGridDB makes up for a request (a new table's grid, a copy):
 * in the language the app sends, else the instance's default. Background
 * work, which has no request, passes no header.
 */
export async function madeNamesFor(
  db: Database,
  acceptLanguage?: string | string[],
): Promise<MadeNames> {
  const asked = acceptedLocale(
    Array.isArray(acceptLanguage) ? acceptLanguage.join(",") : acceptLanguage,
  );
  return madeNames(asked ?? (await readGateSettings(db)).defaultLocale);
}

/**
 * Writes the keys a patch sets. Each key whose value changes is kept in
 * the sign-in trail (ADR 0043): who changed which setting, not the value.
 * Returns the keys that changed.
 */
export async function writeSettings(
  db: Database,
  userId: string,
  patch: InstanceSettingsPatch,
  ip?: string,
): Promise<Array<keyof InstanceSettings>> {
  const current = await readSettings(db);
  const changed: Array<keyof InstanceSettings> = [];
  // A JSON patch may still carry undefined keys at runtime.
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof InstanceSettings, unknown]
  >) {
    if (value === undefined) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
      changed.push(key);
    }
    if (value === null) {
      // A cleared setting (the banner) falls back to its default.
      await db.deleteFrom("instanceSettings").where("key", "=", key).execute();
      continue;
    }
    // JSON text, cast by PostgreSQL: a bare string ("invite") is not JSON.
    const json = JSON.stringify(value);
    await db
      .insertInto("instanceSettings")
      .values({ key, value: json, updatedBy: userId })
      .onConflict((conflict) =>
        conflict.column("key").doUpdateSet({
          value: json,
          updatedBy: userId,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }
  gateCache.delete(db);
  for (const key of changed) {
    await recordAuthEvent(db, {
      action: "settings_changed",
      actorId: userId,
      method: "admin",
      detail: key,
      ip,
    });
  }
  return changed;
}
