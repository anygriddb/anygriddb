/**
 * Accounts by the dozen (ROADMAP #36): several disabled together, and the
 * people of a file added at once, their first link mailed by the queue.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleFor } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "./auth/access.js";
import { keyRing } from "./auth/key-ring.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { DiskStore } from "./files/index.js";
import { clearSmtpCache } from "./integrations/smtp.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { runJobs } from "./queue/run-once.test-helpers.js";
import { taskGroups } from "./queue/tasks.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const RESET = /\/reset\/([A-Za-z0-9_-]{43})/;

describe("accounts by the dozen", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & { SMTP_HOST?: string; SMTP_PORT?: number };
  const closed: string[] = [];
  const hub = {
    closeUser: (userId: string) => closed.push(userId),
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  const account = (email: string) =>
    db
      .selectFrom("users")
      .select(["id", "displayName", "isAdmin", "disabledAt"])
      .where("email", "=", email)
      .executeTakeFirst();
  const queued = async () =>
    Number(
      (
        await pool.query<{ count: string }>(
          "select count(*) as count from graphile_worker._private_jobs",
        )
      ).rows[0]?.count,
    );

  beforeAll(async () => {
    const created = await createTestDatabase("accounts-bulk");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 4 });
    pool.on("error", () => undefined);
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    await admin.call().auth.signup({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // Adding people and disabling accounts ask for a proof again
    // (ROADMAP #28): given once here, it stands for these tests.
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (await account(at("admin")))?.id ?? "";
    const { bus } = recordingBus();
    const groups = taskGroups({
      db,
      bus,
      env,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-bulk-"))),
      log: () => undefined,
    });
    tasks = Object.assign(
      {},
      ...groups.map((group) => group.tasks),
    ) as TaskList;
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await pool.end();
    await close?.();
  });

  it("adds the people of a file with their roles, and mails each a first link", async () => {
    const sales = await insertBase(db, adminId, { name: `Sales ${suffix}` });
    const stock = await insertBase(db, adminId, { name: `Stock ${suffix}` });
    // Two live bases of one name: the file must say which by its id.
    const twin = await insertBase(db, adminId, { name: `Twin ${suffix}` });
    await insertBase(db, adminId, { name: `Twin ${suffix}` });
    await signUpProved(browser(), db, {
      email: at("here"),
      displayName: "Already Here",
      password: PASSWORD,
    });
    const file = [
      "email,name,bases",
      `${at("grace").toUpperCase()},Grace Hopper,sales ${suffix}:editor; Stock ${suffix}:viewer`,
      `${at("alan")},Alan Turing,`,
      `${at("here")},Already Here,`,
      `${at("edsger")},Edsger Dijkstra,Nowhere ${suffix}:viewer`,
      `${at("barbara")},Barbara Liskov,Twin ${suffix}:viewer`,
      `${at("donald")},Donald Knuth,${twin.id}:commenter`,
      `not an address,Nobody,`,
    ].join("\n");

    const preview = await admin.call().admin.people.preview({ file });
    expect(preview.ready).toBe(3);
    expect(
      preview.lines.map((line) => [line.line, line.problem, line.base]),
    ).toEqual([
      [2, null, null],
      [3, null, null],
      [4, "account_exists", null],
      [5, "unknown_base", `Nowhere ${suffix}`],
      [6, "ambiguous_base", `Twin ${suffix}`],
      [7, null, null],
      [8, "invalid_email", null],
    ]);
    expect(preview.lines[0]?.bases).toEqual([
      { baseId: sales.id, name: `Sales ${suffix}`, role: "editor" },
      { baseId: stock.id, name: `Stock ${suffix}`, role: "viewer" },
    ]);
    // A preview writes nothing.
    expect(await account(at("grace"))).toBeUndefined();

    await pool.query("delete from graphile_worker._private_jobs");
    const result = await admin.call().admin.people.add({ file });
    expect(result.added).toBe(3);
    expect(result.refused.map((row) => [row.line, row.problem])).toEqual([
      [4, "account_exists"],
      [5, "unknown_base"],
      [6, "ambiguous_base"],
      [8, "invalid_email"],
    ]);
    const grace = await account(at("grace"));
    expect(grace).toMatchObject({
      displayName: "Grace Hopper",
      isAdmin: false,
      disabledAt: null,
    });
    const bindings = await loadBindings(db, grace?.id ?? "");
    expect(roleFor(bindings, "base", sales.id)).toBe("editor");
    expect(roleFor(bindings, "base", stock.id)).toBe("viewer");
    expect(
      roleFor(
        await loadBindings(db, (await account(at("donald")))?.id ?? ""),
        "base",
        twin.id,
      ),
    ).toBe("commenter");
    // Each is on the sign-in trail under the administrator's name.
    expect(
      await db
        .selectFrom("authEvents")
        .select("userId")
        .where("action", "=", "account_created")
        .where("actorId", "=", adminId)
        .where("userId", "=", grace?.id ?? "")
        .execute(),
    ).toHaveLength(1);

    // No link waits in the queue: it is made when the mail goes.
    expect(await queued()).toBe(3);
    expect(
      await db
        .selectFrom("passwordResets")
        .select("id")
        .where("userId", "=", grace?.id ?? "")
        .execute(),
    ).toEqual([]);
    await runJobs(pool, tasks);
    expect(await queued()).toBe(0);
    const welcome = mailText(await smtp.next(at("grace")));
    expect(welcome).toContain("Ada Admin created an AnyGridDB account");
    await smtp.next(at("alan"));
    await smtp.next(at("donald"));
    const token = RESET.exec(welcome)?.[1] ?? "";
    await browser().call().auth.resetPassword({ token, password: PASSWORD });
    expect(
      await browser()
        .call()
        .auth.login({ email: at("grace"), password: PASSWORD }),
    ).toMatchObject({ status: "session" });

    // The same file again adds nobody.
    const again = await admin.call().admin.people.add({ file });
    expect(again.added).toBe(0);
    expect(again.refused).toHaveLength(7);
    expect(await queued()).toBe(0);
  });

  it("refuses a file that names an administrator column's worth of power, mail that is off, and a person who is not an administrator", async () => {
    // An `admin` column is not one the file knows: nobody is made one.
    const file = `email,name,admin\n${at("mallory")},Mallory,yes`;
    await admin.call().admin.people.add({ file });
    expect(await account(at("mallory"))).toMatchObject({ isAdmin: false });

    const outsider = browser();
    await signUpProved(outsider, db, {
      email: at("outsider"),
      displayName: "Outsider",
      password: PASSWORD,
    });
    const other = `email,name\n${at("eve")},Eve`;
    expect(await code(outsider.call().admin.people.add({ file: other }))).toBe(
      "access_denied",
    );
    expect(
      await code(outsider.call().admin.people.preview({ file: other })),
    ).toBe("access_denied");
    expect(
      await code(outsider.call().admin.disableAccounts({ userIds: [adminId] })),
    ).toBe("access_denied");

    const host = env.SMTP_HOST;
    delete env.SMTP_HOST;
    clearSmtpCache(db);
    try {
      expect(await code(admin.call().admin.people.add({ file: other }))).toBe(
        "smtp_not_configured",
      );
    } finally {
      env.SMTP_HOST = host;
      clearSmtpCache(db);
    }
    expect(await account(at("eve"))).toBeUndefined();
    expect(
      await code(admin.call().admin.people.preview({ file: "who,what\na,b" })),
    ).toBe("people_file_columns");
  });

  it("sends nothing to an account disabled before its mail went", async () => {
    await pool.query("delete from graphile_worker._private_jobs");
    await admin
      .call()
      .admin.people.add({ file: `email,name\n${at("late")},Late Comer` });
    const late = await account(at("late"));
    await admin
      .call()
      .admin.setDisabled({ userId: late?.id ?? "", disabled: true });
    await runJobs(pool, tasks);
    expect(await queued()).toBe(0);
    expect(
      await db
        .selectFrom("passwordResets")
        .select("id")
        .where("userId", "=", late?.id ?? "")
        .execute(),
    ).toEqual([]);
  });

  it("disables several accounts together, and tells apart the one it cannot", async () => {
    const people = [];
    for (const name of ["one", "two", "three"]) {
      const page = browser();
      const id = await signUpProved(page, db, {
        email: at(name),
        displayName: `Person ${name}`,
        password: PASSWORD,
      });
      people.push({ id, page });
    }
    closed.length = 0;
    const result = await admin.call().admin.disableAccounts({
      userIds: [...people.map((person) => person.id), adminId],
    });
    // Their own account is never disabled by their own hand.
    expect(result).toEqual({ disabled: 3, refused: 1 });
    expect((await account(at("admin")))?.disabledAt).toBeNull();
    expect(closed.sort()).toEqual(people.map((person) => person.id).sort());
    for (const name of ["one", "two", "three"]) {
      expect((await account(at(name)))?.disabledAt).not.toBeNull();
    }
    // Sessions ended: the page of one of them is signed out.
    expect(await people[0]?.page.call().session.current()).toBeNull();
    expect(
      await db
        .selectFrom("authEvents")
        .select("userId")
        .where("action", "=", "session_revoked")
        .where("detail", "=", "admin_disable")
        .where("actorId", "=", adminId)
        .where(
          "userId",
          "in",
          people.map((person) => person.id),
        )
        .execute(),
    ).toHaveLength(3);
    expect(
      await code(
        admin.call().admin.disableAccounts({
          userIds: Array.from({ length: 101 }, () => crypto.randomUUID()),
        }),
      ),
    ).toBe("BAD_REQUEST");
  });
});
