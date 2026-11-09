import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signUpWithTable, watchPolicy } from "./setup";

// The journey's PostgreSQL holds AnyGridDB's catalog and, beside it, a
// client's database with an account of its own (ADR 0026).
const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

type Reply = {
  status: number;
  body: {
    result?: { data?: unknown };
    error?: { data?: { reason?: { code?: string } } };
  };
};

/** Calls a tRPC mutation from the page, with its session. */
async function call(page: Page, path: string, input: unknown): Promise<Reply> {
  return page.evaluate(
    async ([path, input]) => {
      const response = await fetch(`/trpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return {
        status: response.status,
        body: (await response.json()) as Reply["body"],
      };
    },
    [path, input] as const,
  );
}

function ok(reply: Reply): unknown {
  expect(reply.status, JSON.stringify(reply.body).slice(0, 300)).toBe(200);
  return reply.body.result?.data;
}

test("a client's rows: locked, signed, told when changed elsewhere, read from a copy, and charted", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const blocked = watchPolicy(page);
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const database = `e2e_rows_${stamp}`;
  const account = `e2e_rows_${stamp}`;
  const password = "reader-password-e2e";
  const server = new URL(controlUrl);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  const erpUrl = new URL(controlUrl);
  erpUrl.pathname = `/${database}`;
  const outside = async (statement: string) => {
    const erp = new pg.Client({ connectionString: erpUrl.toString() });
    await erp.connect();
    await erp.query(statement);
    await erp.end();
  };
  try {
    await control.query(`create role ${account} login password '${password}'`);
    await control.query(`create database ${database}`);
    await outside(`
      create table orders (
        id int primary key,
        customer varchar(40) not null,
        stage varchar(20) not null,
        amount numeric(12,2)
      );
      insert into orders values
        (1, 'Ada', 'won', 1200.00), (2, 'Bob', 'won', 300.50),
        (3, 'Cy', 'lost', 80.00), (4, 'Di', 'open', 45.25);
      grant select, update on orders to ${account};
    `);

    // An administrator declares the source and shows the table in a base.
    const { email } = await signUpWithTable(page, "Admin Rows");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);
    const baseId = (
      await control.query<{ id: string }>(
        "select r.scope_id as id from role_bindings r join users u on u.id = r.user_id where u.email = $1 and r.scope = 'base' and r.role = 'owner'",
        [email],
      )
    ).rows[0]?.id;
    const source = ok(
      await call(page, "admin.sources.create", {
        name: `Rows ${stamp}`,
        engine: "postgres",
        host: server.hostname,
        port: Number(server.port),
        database,
        username: account,
        password,
      }),
    ) as { id: string };
    const exposed = ok(
      await call(page, "admin.sources.expose", {
        sourceId: source.id,
        baseId,
        tables: [{ schema: "public", name: "orders" }],
      }),
    ) as { tableIds: string[] };
    const tableId = exposed.tableIds[0] ?? "";
    ok(
      await call(page, "admin.sources.setWrites", {
        tableId,
        update: true,
        insert: false,
        delete: false,
      }),
    );

    // Statuses (ADR 0033): submitted, then locked from the row's panel.
    await page.goto(`/b/${baseId ?? ""}/t/${tableId}?row=1`);
    const panel = page.getByRole("complementary", {
      name: "Row details",
    });
    const status = panel.getByRole("region", { name: "Row status" });
    await expect(status).toContainText("Draft");
    await status.getByRole("button", { name: "Submit" }).click();
    await expect(status).toContainText("Submitted");
    await status.getByRole("button", { name: "Lock" }).click();
    await expect(status).toContainText("Locked");

    // Another application changes the locked row: signing finds it and
    // refuses, and the row says what moved.
    await outside("update orders set amount = 1250.00 where id = 1");
    await status.getByRole("button", { name: "Sign" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Meaning").fill("Approuvé");
    await dialog.getByLabel("Password").fill("correct-horse-battery");
    await dialog.getByRole("button", { name: "Sign" }).click();
    await expect(
      page.getByText(/changed outside AnyGridDB since it was locked/).first(),
    ).toBeVisible();
    // The row cannot be signed now: the dialog closes by itself.
    await expect(dialog).toBeHidden();
    await expect(status.getByRole("alert")).toContainText("amount", {
      timeout: 30_000,
    });

    // Put back, locked again by an owner, then signed.
    await outside("update orders set amount = 1200.00 where id = 1");
    await status.getByRole("button", { name: "Unlock" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Unlock" })
      .click();
    await expect(status).toContainText("Draft");
    await status.getByRole("button", { name: "Submit" }).click();
    await status.getByRole("button", { name: "Lock" }).click();
    await expect(status).toContainText("Locked");
    await status.getByRole("button", { name: "Sign" }).click();
    await dialog.getByLabel("Meaning").fill("Approuvé");
    await dialog.getByLabel("Password").fill("correct-horse-battery");
    await dialog.getByRole("button", { name: "Sign" }).click();
    await expect(status).toContainText("Signed by Admin Rows");

    // Synced mode (ADR 0034): the table reads from a copy in AnyGridDB.
    ok(
      await call(page, "admin.sources.setSync", {
        tableId,
        intervalMinutes: 15,
      }),
    );
    await page.goto(`/b/${baseId ?? ""}/t/${tableId}`);
    await expect(page.getByRole("note")).toContainText(
      "Copy of the client's database from",
      { timeout: 30_000 },
    );
    const grid = page.getByRole("grid");
    await expect(
      grid.getByRole("gridcell", { name: /^customer: / }),
    ).toHaveCount(4);

    // A dashboard chart (ADR 0035): amounts by stage, from the copy.
    const dashboard = ok(
      await call(page, "dashboards.create", { baseId, name: "Ventes" }),
    ) as { id: string };
    const columns = (
      await control.query<{ name: string; physical_name: string }>(
        "select name, physical_name from data_columns where table_id = $1",
        [tableId],
      )
    ).rows;
    const field = (physical: string) =>
      columns.find((column) => column.physical_name === physical)?.name;
    ok(
      await call(page, "dashboards.upsertWidget", {
        dashboardId: dashboard.id,
        title: "Amount by stage",
        kind: "chart",
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        config: {
          tableId,
          groupBy: field("stage"),
          chartType: "bar",
          fn: "sum",
          column: field("amount"),
        },
      }),
    );
    await page.goto(`/b/${baseId ?? ""}/dashboards`);
    await page.getByText("Ventes", { exact: true }).click();
    await page
      .getByRole("button", { name: "Show the table of values" })
      .click();
    const table = page.getByRole("table");
    await expect(table.getByRole("row", { name: /won/ })).toContainText(
      /1[\s ,]?500[,.]5/,
    );
    await expect(table.getByRole("row", { name: /lost/ })).toContainText("80");

    expect(blocked).toEqual([]);
  } finally {
    await control.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
      [database],
    );
    await control.query(`drop database if exists ${database}`).catch(() => {
      // Dropped with the e2e stack anyway.
    });
    await control.end();
  }
});
