import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import {
  accessibilityViolations,
  clusterUrl,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

// The journey's PostgreSQL holds AnyGridDB's catalog and, beside it, a
// client's database with an account of its own (ADR 0026).
const controlUrl = clusterUrl();

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
  const stamp = uniqueStamp();
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
    // A change made in Administration asks for the proof (ADR 0073): the
    // journey calls the server itself, so it gives it itself.
    ok(await call(page, "admin.stepUp", { password: "correct-horse-battery" }));
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
    // A draft says nothing: it is submitted from the panel's menu.
    await expect(status).toHaveCount(0);
    const submit = async () => {
      await panel.getByRole("button", { name: "More actions" }).click();
      await page
        .getByRole("menuitem", { name: "Submit the row for review" })
        .click();
    };
    await submit();
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
    await expect(status).toHaveCount(0);
    await submit();
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
    // The sidebar holds a line for the base's dashboards, beside its
    // tables, and names those of the base on screen under it.
    const navigation = page.getByRole("navigation", { name: "Bases" });
    await expect(
      navigation.getByRole("link", { name: "Dashboards", exact: true }),
    ).toBeVisible();
    const named = navigation.getByRole("list", { name: "Dashboards" });
    await named.getByRole("link", { name: "Ventes", exact: true }).click();
    await page
      .getByRole("button", { name: "Show the table of values" })
      .click();
    const table = page.getByRole("table");
    await expect(table.getByRole("row", { name: /won/ })).toContainText(
      /1[\s ,]?500[,.]5/,
    );
    await expect(table.getByRole("row", { name: /lost/ })).toContainText("80");

    // Renamed from its page, and a second widget put before the chart
    // from its menu: the server took both, and now a screen asks.
    await page.getByRole("button", { name: "Rename the dashboard" }).click();
    const rename = page.getByRole("dialog", { name: "Rename the dashboard" });
    await rename.getByLabel("Name").fill("Ventes 2026");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Ventes 2026" }),
    ).toBeVisible();
    await expect(
      named.getByRole("link", { name: "Ventes 2026", exact: true }),
    ).toBeVisible();
    ok(
      await call(page, "dashboards.upsertWidget", {
        dashboardId: dashboard.id,
        title: "Total amount",
        kind: "metric",
        x: 0,
        y: 4,
        w: 3,
        h: 2,
        config: { tableId, column: field("amount"), fn: "sum" },
      }),
    );
    await page.reload();
    const titles = page.locator("article h2");
    await expect(titles).toHaveText(["Amount by stage", "Total amount"]);
    await page
      .getByRole("button", { name: "Actions for Total amount" })
      .click();
    await page.getByRole("menuitem", { name: "Move earlier" }).click();
    await expect(titles).toHaveText(["Total amount", "Amount by stage"]);
    expect(await accessibilityViolations(page)).toEqual([]);

    // A histogram, made from the screen: the four amounts counted in two
    // bins between the least and the greatest, each named by its bounds.
    await page.getByRole("button", { name: "Add a widget" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Amounts");
    await page.getByLabel("Type", { exact: true }).selectOption("chart");
    await page.getByLabel("Style", { exact: true }).selectOption("histogram");
    // The base's first table holds no number: the form says so, and
    // offers nothing to add.
    await expect(
      page.getByText("This table has no number field to count in bins."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Table", { exact: true }).selectOption(tableId);
    // A histogram has no groups, no series and no other measure to ask.
    await expect(page.getByLabel("Group by")).toHaveCount(0);
    await expect(page.getByLabel("Measure", { exact: true })).toHaveCount(0);
    await page
      .getByLabel("Number field", { exact: true })
      .selectOption(field("amount") ?? "");
    await page.getByLabel("Bins", { exact: true }).fill("2");
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const amounts = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Amounts" }) });
    await amounts
      .getByRole("button", { name: "Show the table of values" })
      .click();
    // 45.25, 80 and 300.5 below the middle, 1,200 above it.
    await expect(amounts.getByRole("row", { name: /45 – 623/ })).toContainText(
      "3",
    );
    await expect(
      amounts.getByRole("row", { name: /623 – 1[\s ,]?200/ }),
    ).toContainText("1");
    expect(await accessibilityViolations(page)).toEqual([]);

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
