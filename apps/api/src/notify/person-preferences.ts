/**
 * Resolves which channels a person gets for one event (ADR 0123): their
 * own row, else the instance default, else the catalogue's built-in
 * defaults, always with required channels kept.
 */
import {
  channelIsOptional,
  personEvent,
  PERSON_EVENT_CATALOG,
  PERSON_EVENTS,
  withRequiredChannels,
  type PersonChannel,
  type PersonEvent,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";

const CHANNELS = new Set<PersonChannel>([
  "in_app",
  "email_immediate",
  "email_daily",
  "email_weekly",
]);

/** A stored list of channels, keeping only those the catalogue knows. */
function asChannels(value: unknown): PersonChannel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PersonChannel =>
      typeof item === "string" && CHANNELS.has(item as PersonChannel),
  );
}

/** Built-in or administrator defaults for every event. */
export async function readDefaultChannels(
  db: Database,
): Promise<Map<PersonEvent, PersonChannel[]>> {
  const rows = await db
    .selectFrom("notificationDefaults")
    .select(["event", "channels"])
    .execute();
  const byEvent = new Map(
    rows.map((row) => [row.event as PersonEvent, asChannels(row.channels)]),
  );
  const result = new Map<PersonEvent, PersonChannel[]>();
  for (const event of PERSON_EVENT_CATALOG) {
    const chosen = byEvent.get(event.id) ?? [...event.defaults];
    result.set(event.id, withRequiredChannels(event.id, chosen));
  }
  return result;
}

/**
 * Channels for one person and one event. A missing preference row means
 * the instance default.
 */
export async function channelsFor(
  db: Database,
  userId: string,
  event: PersonEvent,
  defaults?: Map<PersonEvent, PersonChannel[]>,
): Promise<PersonChannel[]> {
  const row = await db
    .selectFrom("notificationPreferences")
    .select("channels")
    .where("userId", "=", userId)
    .where("event", "=", event)
    .executeTakeFirst();
  if (row) return withRequiredChannels(event, asChannels(row.channels));
  const known = defaults ?? (await readDefaultChannels(db));
  return known.get(event) ?? withRequiredChannels(event, []);
}

/**
 * Channels for many people and one event, in one round of reads.
 */
export async function channelsForMany(
  db: Database,
  userIds: readonly string[],
  event: PersonEvent,
): Promise<Map<string, PersonChannel[]>> {
  const result = new Map<string, PersonChannel[]>();
  if (userIds.length === 0) return result;
  const defaults = await readDefaultChannels(db);
  const fallback =
    defaults.get(event) ??
    withRequiredChannels(event, personEvent(event).defaults);
  const rows = await db
    .selectFrom("notificationPreferences")
    .select(["userId", "channels"])
    .where("userId", "in", [...userIds])
    .where("event", "=", event)
    .execute();
  const byUser = new Map(
    rows.map((row) => [
      row.userId,
      withRequiredChannels(event, asChannels(row.channels)),
    ]),
  );
  for (const userId of userIds) {
    result.set(userId, byUser.get(userId) ?? fallback);
  }
  return result;
}

/**
 * Whether a scoped event about this table is muted for the person (the
 * table itself, or its base).
 */
export async function isMuted(
  db: Database,
  userId: string,
  scope: { baseId?: string | null; tableId?: string | null },
): Promise<boolean> {
  if (!scope.baseId && !scope.tableId) return false;
  const row = await db
    .selectFrom("notificationMutes")
    .select("id")
    .where("userId", "=", userId)
    .where((eb) => {
      const parts = [];
      if (scope.tableId) {
        parts.push(eb("tableId", "=", scope.tableId));
      }
      if (scope.baseId) {
        parts.push(
          eb.and([eb("baseId", "=", scope.baseId), eb("tableId", "is", null)]),
        );
      }
      return eb.or(parts);
    })
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Mutes that match any of the given people and tables, as a set of keys. */
export async function mutedKeys(
  db: Database,
  userIds: readonly string[],
  tables: ReadonlyArray<{ id: string; baseId: string }>,
): Promise<Set<string>> {
  const muted = new Set<string>();
  if (userIds.length === 0 || tables.length === 0) return muted;
  const tableIds = tables.map((table) => table.id);
  const baseIds = [...new Set(tables.map((table) => table.baseId))];
  const rows = await db
    .selectFrom("notificationMutes")
    .select(["userId", "baseId", "tableId"])
    .where("userId", "in", [...userIds])
    .where((eb) =>
      eb.or([
        eb("tableId", "in", tableIds),
        eb.and([eb("baseId", "in", baseIds), eb("tableId", "is", null)]),
      ]),
    )
    .execute();
  const baseOf = new Map(tables.map((table) => [table.id, table.baseId]));
  for (const row of rows) {
    if (row.tableId) {
      muted.add(`${row.userId}:t:${row.tableId}`);
      continue;
    }
    if (!row.baseId) continue;
    for (const [tableId, baseId] of baseOf) {
      if (baseId === row.baseId) muted.add(`${row.userId}:t:${tableId}`);
    }
    muted.add(`${row.userId}:b:${row.baseId}`);
  }
  return muted;
}

export function muteKey(
  userId: string,
  scope: { tableId?: string | null; baseId?: string | null },
): string | null {
  if (scope.tableId) return `${userId}:t:${scope.tableId}`;
  if (scope.baseId) return `${userId}:b:${scope.baseId}`;
  return null;
}

/** Saves one person's channels for one event, keeping required ones. */
export async function savePreference(
  db: Database,
  userId: string,
  event: PersonEvent,
  channels: readonly PersonChannel[],
): Promise<PersonChannel[]> {
  const kept = withRequiredChannels(event, channels);
  await db
    .insertInto("notificationPreferences")
    .values({ userId, event, channels: kept })
    .onConflict((conflict) =>
      conflict.columns(["userId", "event"]).doUpdateSet({
        channels: kept,
        updatedAt: new Date(),
      }),
    )
    .execute();
  return kept;
}

/** Removes one channel from an event's preference (unsubscribe link). */
export async function removeChannel(
  db: Database,
  userId: string,
  event: PersonEvent,
  channel: PersonChannel,
): Promise<{ channels: PersonChannel[]; refused: boolean }> {
  const current = await channelsFor(db, userId, event);
  if (!channelIsOptional(event, channel)) {
    return { channels: current, refused: true };
  }
  const next = current.filter((item) => item !== channel);
  const kept = await savePreference(db, userId, event, next);
  return { channels: kept, refused: false };
}

/**
 * Removes one channel from every event that uses it and may lose it (a
 * digest's unsubscribe link). Required channels stay where they are.
 */
export async function removeChannelEverywhere(
  db: Database,
  userId: string,
  channel: PersonChannel,
): Promise<void> {
  for (const event of PERSON_EVENTS) {
    if (!channelIsOptional(event, channel)) continue;
    const current = await channelsFor(db, userId, event);
    if (!current.includes(channel)) continue;
    await savePreference(
      db,
      userId,
      event,
      current.filter((item) => item !== channel),
    );
  }
}

/** Administrator defaults for one event. */
export async function saveDefault(
  db: Database,
  event: PersonEvent,
  channels: readonly PersonChannel[],
  updatedBy: string,
): Promise<PersonChannel[]> {
  const kept = withRequiredChannels(event, channels);
  await db
    .insertInto("notificationDefaults")
    .values({ event, channels: kept, updatedBy })
    .onConflict((conflict) =>
      conflict.column("event").doUpdateSet({
        channels: kept,
        updatedAt: new Date(),
        updatedBy,
      }),
    )
    .execute();
  return kept;
}

export async function listMutes(db: Database, userId: string) {
  return db
    .selectFrom("notificationMutes as m")
    .leftJoin("bases as b", "b.id", "m.baseId")
    .leftJoin("dataTables as t", "t.id", "m.tableId")
    .select([
      "m.id",
      "m.baseId",
      "m.tableId",
      "m.createdAt",
      "b.name as baseName",
      "t.name as tableName",
    ])
    .where("m.userId", "=", userId)
    .orderBy("m.createdAt", "desc")
    .execute();
}

export async function addMute(
  db: Database,
  userId: string,
  input: { baseId: string; tableId?: string },
): Promise<void> {
  await db
    .insertInto("notificationMutes")
    .values({
      userId,
      baseId: input.baseId,
      tableId: input.tableId ?? null,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

export async function removeMute(
  db: Database,
  userId: string,
  muteId: string,
): Promise<void> {
  await db
    .deleteFrom("notificationMutes")
    .where("id", "=", muteId)
    .where("userId", "=", userId)
    .execute();
}
