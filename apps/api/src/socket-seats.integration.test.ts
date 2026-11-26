/**
 * Live connections counted where every process sees them (ADR 0132): an
 * account holds at most what it may, however many processes serve it; a
 * socket that closes gives its seat back, and a process that stopped is
 * no longer counted.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seatFor, SocketSeats } from "./socket-seats.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");

describe("live connections counted across processes", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  async function account(name: string): Promise<string> {
    const row = await db
      .insertInto("users")
      .values({ email: `${name}-${suffix}@example.com`, displayName: name })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("live_sockets");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses one socket too many, whichever process it reaches, and takes one when another closes", async () => {
    const [first, second] = [new SocketSeats(db), new SocketSeats(db)];
    const busy = await account("busy");
    const other = await account("other");
    // Opened at once on both processes: never more than allowed.
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).take(busy, 4),
      ),
    );
    expect(answers.filter((seat) => seat === "taken")).toHaveLength(4);
    expect(await first.take(other, 4)).toBe("taken");
    // One of them closes, on whichever process holds it.
    const { processId } = await db
      .selectFrom("liveSockets")
      .select("processId")
      .where("userId", "=", busy)
      .executeTakeFirstOrThrow();
    await (processId === first.processId ? first : second).leave(busy);
    expect(await second.take(busy, 4)).toBe("taken");
    expect(await first.take(busy, 4)).toBe("full");
    // Raised by Administration, the next one is taken.
    expect(await first.take(busy, 5)).toBe("taken");
  });

  it("no longer counts a process that stopped renewing, and forgets it", async () => {
    const [stopped, alive] = [new SocketSeats(db), new SocketSeats(db)];
    const person = await account("person");
    expect(await stopped.take(person, 2)).toBe("taken");
    expect(await alive.take(person, 2)).toBe("taken");
    expect(await alive.take(person, 2)).toBe("full");
    await sql`
      update live_sockets set seen_at = now() - interval '2 minutes'
       where process_id = ${stopped.processId}
    `.execute(db);
    await alive.renew();
    expect(await alive.take(person, 2)).toBe("taken");
    await sql`
      update live_sockets set seen_at = now() - interval '10 minutes'
       where process_id = ${stopped.processId}
    `.execute(db);
    await alive.renew();
    const left = await db
      .selectFrom("liveSockets")
      .select(["processId", "open"])
      .where("userId", "=", person)
      .execute();
    expect(left).toEqual([{ processId: alive.processId, open: 2 }]);
    // A process that stops gives back what it held.
    await alive.close();
    expect(
      await db
        .selectFrom("liveSockets")
        .select("open")
        .where("userId", "=", person)
        .execute(),
    ).toEqual([]);
  });

  it("lets a socket through uncounted when the database does not answer, and says so", async () => {
    const gone = new SocketSeats({
      transaction: () => {
        throw new Error("no database");
      },
    } as unknown as Database);
    const said: unknown[] = [];
    expect(
      await seatFor(gone, "00000000-0000-4000-8000-000000000001", 4, (error) =>
        said.push(error),
      ),
    ).toBe("uncounted");
    expect(said).toHaveLength(1);
  });
});
