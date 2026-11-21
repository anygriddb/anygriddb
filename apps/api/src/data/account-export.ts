/**
 * An account's data, for the administrator who is asked for it (ROADMAP
 * #32): its profile, its memberships, its sign-ins, where it commented,
 * what it wrote (field names, never a value), and what was done to it. The
 * account's page reads a short summary; a background job writes the file
 * a page at a time.
 *
 * What people type in bases stays there: a cell's value and a comment's
 * text are the base's, read by its members, and an administrator opens a
 * base only by telling its owners (ADR 0074). The file says what it holds
 * and what it leaves out. It is an export, not an answer to a request the
 * instance's operator has to give.
 */
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { listApiTokens } from "../auth/tokens.js";
import { ERASED_USER_ID } from "./erasure.js";
import { liveBase, liveTable } from "./live.js";

/** The most rows of each long list the file holds; it says when one is cut. */
const ACCOUNT_LIST_LIMIT = 10_000;
/** Rows read at a time while the file is written: never a list whole. */
const ACCOUNT_DATA_PAGE = 500;
/** Recent rows shown on the account's page. */
const ACCOUNT_SUMMARY_RECENT = 20;

export const accountExportInputSchema = z.object({ userId: z.uuid() }).strict();

/** Columns every write touches: the row's own clock and author. */
const SYSTEM_KEY = /^(id|ag_[a-z_]+)$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The fields a write changed, by name: those whose value differs between
 * the row before and the row after, or, for a row made, those it filled.
 * The trail keeps the whole row on both sides, so the names of all its
 * fields would say nothing.
 */
export function changedFields(oldValue: unknown, newValue: unknown): string[] {
  const before = record(oldValue);
  const after = record(newValue);
  if (!after) return [];
  const names = Object.keys(after).filter((name) => !SYSTEM_KEY.test(name));
  const changed = before
    ? names.filter(
        (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]),
      )
    : names.filter((name) => after[name] !== null && after[name] !== "");
  return changed.sort();
}

async function writeText(stream: WriteStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, "drain");
}

async function assertPerson(db: Database, userId: string): Promise<void> {
  if (userId === ERASED_USER_ID) throw new AppError("invalid_account");
  const found = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!found) throw new AppError("unknown_account");
}

/**
 * On-screen summary for the account page: counts and recent writes /
 * account events (as author or as subject).
 */
export async function accountDataSummary(db: Database, userId: string) {
  await assertPerson(db, userId);

  const [
    writeCount,
    accountEventCount,
    commentCount,
    recentWrites,
    recentAccount,
  ] = await Promise.all([
    db
      .selectFrom("auditEvents")
      .select((eb) => eb.fn.countAll<string>().as("value"))
      .where("userId", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("authEvents")
      .select((eb) => eb.fn.countAll<string>().as("value"))
      .where((eb) =>
        eb.or([eb("userId", "=", userId), eb("actorId", "=", userId)]),
      )
      .executeTakeFirst(),
    db
      .selectFrom("comments")
      .select((eb) => eb.fn.countAll<string>().as("value"))
      .where("authorId", "=", userId)
      .executeTakeFirst(),
    db
      .selectFrom("auditEvents as e")
      .leftJoin("dataTables as t", "t.id", "e.tableId")
      .leftJoin("bases as b", "b.id", "t.baseId")
      .select([
        "e.id",
        "e.occurredAt",
        "e.action",
        "t.name as tableName",
        "b.name as baseName",
      ])
      .where("e.userId", "=", userId)
      .orderBy("e.occurredAt", "desc")
      .limit(ACCOUNT_SUMMARY_RECENT)
      .execute(),
    db
      .selectFrom("authEvents")
      .select([
        "id",
        "occurredAt",
        "action",
        "method",
        "detail",
        "ip",
        "userId",
        "actorId",
      ])
      .where((eb) =>
        eb.or([eb("userId", "=", userId), eb("actorId", "=", userId)]),
      )
      .orderBy("occurredAt", "desc")
      .limit(ACCOUNT_SUMMARY_RECENT)
      .execute(),
  ]);

  return {
    writes: Number(writeCount?.value ?? 0),
    accountEvents: Number(accountEventCount?.value ?? 0),
    comments: Number(commentCount?.value ?? 0),
    recentWrites: recentWrites.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      tableName: row.tableName,
      baseName: row.baseName,
    })),
    recentAccount: recentAccount.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      method: row.method,
      detail: row.detail,
      ip: row.ip,
      asAuthor: row.actorId === userId,
      asSubject: row.userId === userId,
    })),
  };
}

type AccountDataCounts = {
  signIns: number;
  comments: number;
  writes: number;
};

/**
 * Streams one person's archive to `path` as JSON. Long lists are written
 * a page at a time so tens of thousands of trail rows never sit in memory
 * together. Cell values, password hashes, token secrets, and factor
 * material stay out.
 */
export async function writeAccountDataFile(
  db: Database,
  userId: string,
  path: string,
  onProgress?: (done: number, total: number | null) => Promise<void>,
  /** The most lines of a list, and the lines read at a time. */
  limits: ListLimits = { list: ACCOUNT_LIST_LIMIT, page: ACCOUNT_DATA_PAGE },
): Promise<{ size: number; counts: AccountDataCounts; displayName: string }> {
  await assertPerson(db, userId);

  const account = await db
    .selectFrom("users")
    .select([
      "id",
      "email",
      "displayName",
      "isAdmin",
      "isSupport",
      "createdAt",
      "disabledAt",
      "disabledReason",
      "scimUserName",
      "scimGivenName",
      "scimFamilyName",
      "deprovisionedAt",
    ])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  const [bases, tables, groups, sessions, tokens] = await Promise.all([
    db
      .selectFrom("roleBindings as b")
      .innerJoin("bases as base", "base.id", "b.scopeId")
      .leftJoin("groups as g", "g.id", "b.groupId")
      .select(["base.id", "base.name", "b.role", "g.displayName as viaGroup"])
      .where("b.userId", "=", userId)
      .where("b.scope", "=", "base")
      .where(liveBase("base"))
      .orderBy("base.name", "asc")
      .execute(),
    db
      .selectFrom("roleBindings as b")
      .innerJoin("dataTables as t", "t.id", "b.scopeId")
      .innerJoin("bases as base", "base.id", "t.baseId")
      .leftJoin("groups as g", "g.id", "b.groupId")
      .select([
        "t.id",
        "t.name",
        "base.name as baseName",
        "b.role",
        "g.displayName as viaGroup",
      ])
      .where("b.userId", "=", userId)
      .where("b.scope", "=", "table")
      .where(liveTable("t"))
      .where(liveBase("base"))
      .orderBy("base.name", "asc")
      .orderBy("t.name", "asc")
      .execute(),
    db
      .selectFrom("groupMembers as m")
      .innerJoin("groups as g", "g.id", "m.groupId")
      .select(["g.id", "g.displayName"])
      .where("m.userId", "=", userId)
      .orderBy("g.displayName", "asc")
      .execute(),
    db
      .selectFrom("sessions")
      .select(["id", "createdAt", "expiresAt"])
      .where("userId", "=", userId)
      .where("expiresAt", ">", new Date())
      .orderBy("createdAt", "desc")
      .limit(200)
      .execute(),
    listApiTokens(db, userId),
  ]);

  await onProgress?.(0, 4);

  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const lists: Record<keyof AccountDataCounts, ListEnd> = {
    signIns: { written: 0, complete: true },
    comments: { written: 0, complete: true },
    writes: { written: 0, complete: true },
  };

  try {
    const header = {
      exportedAt: new Date().toISOString(),
      about:
        "The data this instance holds about one account. What the account typed in bases (cell values, comment texts, files) is not in this file: it belongs to those bases.",
      includes: [
        "profile",
        "roles on bases and tables, and groups",
        "open sessions",
        "API tokens (name, limits, dates; never the token)",
        "sign-in and account events, as author or as subject",
        "comments (where and when; not their text)",
        "writes (table, row, action, names of the fields changed)",
      ],
      excludes: [
        "cell values",
        "comment texts",
        "attached files",
        "password, tokens, and second factors",
      ],
      listLimit: limits.list,
      profile: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        isAdmin: account.isAdmin,
        isSupport: account.isSupport,
        createdAt: account.createdAt.toISOString(),
        disabledAt: account.disabledAt?.toISOString() ?? null,
        disabledReason: account.disabledReason,
        provisioned: account.scimUserName !== null,
        givenName: account.scimGivenName,
        familyName: account.scimFamilyName,
        deprovisioned: account.deprovisionedAt !== null,
      },
      memberships: {
        bases: bases.map((row) => ({
          id: row.id,
          name: row.name,
          role: row.role,
          viaGroup: row.viaGroup,
        })),
        tables: tables.map((row) => ({
          id: row.id,
          name: row.name,
          base: row.baseName,
          role: row.role,
          viaGroup: row.viaGroup,
        })),
        groups: groups.map((row) => ({
          id: row.id,
          displayName: row.displayName,
        })),
      },
      sessions: sessions.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      tokens: tokens.map((row) => ({
        id: row.id,
        name: row.name,
        readOnly: row.readOnly,
        expiresAt: row.expiresAt,
        lastUsedAt: row.lastUsedAt,
      })),
    };

    const opening = JSON.stringify(header);
    // Without its closing brace: the long lists follow as its other keys.
    await writeText(stream, `${opening.slice(0, -1)},"signIns":`);

    lists.signIns = await writeList(stream, limits, async (after, limit) => {
      const rows = await db
        .selectFrom("authEvents")
        .select([
          "id",
          "occurredAt",
          "action",
          "method",
          "detail",
          "ip",
          "userId",
          "actorId",
        ])
        .where((eb) =>
          eb.or([eb("userId", "=", userId), eb("actorId", "=", userId)]),
        )
        .$if(after !== null, (query) =>
          query.where((eb) =>
            eb(
              eb.refTuple("occurredAt", "id"),
              "<",
              eb.tuple(after?.at ?? new Date(0), after?.id ?? ""),
            ),
          ),
        )
        .orderBy("occurredAt", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        at: row.occurredAt,
        id: row.id,
        line: {
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          action: row.action,
          method: row.method,
          detail: row.detail,
          ip: row.ip,
          asAuthor: row.actorId === userId,
          asSubject: row.userId === userId,
        },
      }));
    });
    await onProgress?.(1, 4);

    await writeText(stream, ',"comments":');
    lists.comments = await writeList(stream, limits, async (after, limit) => {
      const rows = await db
        .selectFrom("comments as c")
        .leftJoin("dataTables as t", "t.id", "c.tableId")
        .select([
          "c.id",
          "c.tableId",
          "t.name as tableName",
          "c.rowId",
          "c.createdAt",
          "c.deletedAt",
        ])
        .where("c.authorId", "=", userId)
        .$if(after !== null, (query) =>
          query.where((eb) =>
            eb(
              eb.refTuple("c.createdAt", "c.id"),
              "<",
              eb.tuple(after?.at ?? new Date(0), after?.id ?? ""),
            ),
          ),
        )
        .orderBy("c.createdAt", "desc")
        .orderBy("c.id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        at: row.createdAt,
        id: row.id,
        line: {
          id: row.id,
          tableId: row.tableId,
          tableName: row.tableName,
          rowId: row.rowId,
          createdAt: row.createdAt.toISOString(),
          deletedAt: row.deletedAt?.toISOString() ?? null,
        },
      }));
    });
    await onProgress?.(2, 4);

    await writeText(stream, ',"writes":');
    lists.writes = await writeList(stream, limits, async (after, limit) => {
      const rows = await db
        .selectFrom("auditEvents as e")
        .leftJoin("dataTables as t", "t.id", "e.tableId")
        .leftJoin("bases as b", "b.id", "t.baseId")
        .select([
          "e.id",
          "e.occurredAt",
          "e.action",
          "e.tableId",
          "t.name as tableName",
          "b.name as baseName",
          "e.recordId",
          "e.source",
          "e.oldValue",
          "e.newValue",
        ])
        .where("e.userId", "=", userId)
        .$if(after !== null, (query) =>
          query.where((eb) =>
            eb(
              eb.refTuple("e.occurredAt", "e.id"),
              "<",
              eb.tuple(after?.at ?? new Date(0), after?.id ?? ""),
            ),
          ),
        )
        .orderBy("e.occurredAt", "desc")
        .orderBy("e.id", "desc")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        at: row.occurredAt,
        id: row.id,
        line: {
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          action: row.action,
          tableId: row.tableId,
          tableName: row.tableName,
          baseName: row.baseName,
          recordId: row.recordId,
          source: row.source,
          fields: changedFields(row.oldValue, row.newValue),
        },
      }));
    });
    await onProgress?.(3, 4);

    // Last, since it is known last: how many lines each list holds, and
    // whether the list ends there or was cut at the limit.
    await writeText(stream, `,"lists":${JSON.stringify(lists)}}`);
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.end(() => resolve());
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }

  await onProgress?.(4, 4);
  const { size } = await stat(path);
  return {
    size,
    counts: {
      signIns: lists.signIns.written,
      comments: lists.comments.written,
      writes: lists.writes.written,
    },
    displayName: account.displayName,
  };
}

/** How a list of the file ended: its lines, and whether there were more. */
type ListEnd = { written: number; complete: boolean };
/** A line of a list, and what the next page starts after. */
type Line = { at: Date; id: string; line: object };
type After = { at: Date; id: string } | null;
type ListLimits = { list: number; page: number };

/**
 * Writes a list as a JSON array, newest first, a page at a time: each
 * page starts after the last line of the one before (not at an offset,
 * which lines written meanwhile would shift), and is released before the
 * next is read. Stops at the limit, and says whether lines were left.
 */
async function writeList(
  stream: WriteStream,
  limits: ListLimits,
  readPage: (after: After, limit: number) => Promise<Line[]>,
): Promise<ListEnd> {
  await writeText(stream, "[");
  let after: After = null;
  let written = 0;
  let complete = true;
  for (;;) {
    const room = limits.list - written;
    if (room === 0) {
      complete = (await readPage(after, 1)).length === 0;
      break;
    }
    const limit = Math.min(limits.page, room);
    const rows = await readPage(after, limit);
    for (const row of rows) {
      const text = JSON.stringify(row.line);
      await writeText(stream, written === 0 ? text : `,${text}`);
      written += 1;
    }
    const last = rows.at(-1);
    if (!last || rows.length < limit) break;
    after = { at: last.at, id: last.id };
  }
  await writeText(stream, "]");
  return { written, complete };
}
