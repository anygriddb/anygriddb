import { expect, test } from "@playwright/test";
import pg from "pg";
import {
  accessibilityViolations,
  clusterUrl,
  proveItIsYou,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

// The journey's PostgreSQL holds AnyGridDB's catalog and, beside it, a
// client's database with an account of its own (ADR 0026).
const controlUrl = clusterUrl();

test("an administrator shows a client's tables in a base, read where they live", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const stamp = uniqueStamp();
  const database = `e2e_erp_${stamp}`;
  const account = `e2e_reader_${stamp}`;
  const password = "reader-password-e2e";
  const server = new URL(controlUrl);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    await control.query(`create role ${account} login password '${password}'`);
    await control.query(`create database ${database}`);
    const erpUrl = new URL(controlUrl);
    erpUrl.pathname = `/${database}`;
    const erp = new pg.Client({ connectionString: erpUrl.toString() });
    await erp.connect();
    await erp.query(`
      create type invoice_status as enum ('draft', 'sent', 'paid');
      create table customers (id serial primary key, name varchar(120) not null);
      create table invoices (
        id bigint primary key,
        customer_id int references customers(id),
        amount numeric(14,2),
        status invoice_status not null default 'draft'
      );
      insert into customers (name) values ('Ada'), ('Bob');
      insert into invoices values
        (1001, 1, 120.50, 'paid'),
        (1002, 1, 99999999999.99, 'sent'),
        (1003, 2, 7.25, 'draft');
      grant select on customers, invoices to ${account};
    `);
    await erp.end();

    const { email } = await signUpWithTable(page, "Admin Sources");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    await page.goto("/admin/sources");
    await page.getByRole("button", { name: "Add a source" }).click();
    const dialog = page.getByRole("dialog");
    // A store that speaks no SQL is read from a copy (ADR 0088): its form
    // says so, and asks for nothing a copy has no use for.
    const engine = dialog.getByRole("group", { name: "Engine" });
    await engine.getByText("MongoDB", { exact: true }).click();
    await expect(engine.getByRole("radio", { name: "MongoDB" })).toBeChecked();
    await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue(
      "27017",
    );
    await expect(
      dialog.getByText(/AnyGridDB reads this source from a copy/),
    ).toBeVisible();
    await expect(dialog.getByLabel("Time zone", { exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByLabel(/Schema kept for AnyGridDB/)).toHaveCount(0);
    await expect(dialog.getByLabel(/Read replica host/)).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    // A SQL engine's form has them back.
    await engine.getByText("PostgreSQL", { exact: true }).click();
    await expect(
      engine.getByRole("radio", { name: "PostgreSQL" }),
    ).toBeChecked();
    await expect(dialog.getByLabel(/Schema kept for AnyGridDB/)).toBeVisible();
    await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue(
      "5432",
    );
    await dialog.getByLabel("Name", { exact: true }).fill(`ERP ${stamp}`);
    // Exact names: the read replica's fields are named after these.
    await dialog.getByLabel("Database", { exact: true }).fill(database);
    await dialog.getByLabel("Host", { exact: true }).fill(server.hostname);
    await dialog.getByLabel("Port", { exact: true }).fill(server.port);
    await dialog.getByLabel("Account", { exact: true }).fill(account);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Save" }).click();
    // A change made in Administration asks for the proof (ADR 0073): the
    // source is saved once it is given.
    await proveItIsYou(page);
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("cell", { name: `ERP ${stamp}`, exact: true }),
    ).toBeVisible();

    // The administrator picks the tables; nothing shows by default.
    await page
      .getByRole("row", { name: new RegExp(`ERP ${stamp}`) })
      .getByRole("button", { name: "Tables" })
      .click();
    await dialog.getByLabel("Expose public.customers").check();
    await dialog.getByLabel("Expose public.invoices").check();
    await dialog.getByRole("button", { name: "Expose 2 tables" }).click();
    await expect(page.getByText("2 tables added to Lab")).toBeVisible();
    await expect(dialog.getByLabel("Expose public.invoices")).toBeDisabled();
    await page.keyboard.press("Escape");

    // The sidebar names the database they live in, and leads to them.
    await page.goto("/");
    const sources = page.getByRole("region", { name: "Sources" });
    await sources
      .getByRole("button", { name: new RegExp(`ERP ${stamp}`) })
      .click();
    await expect(
      sources.getByRole("link", { name: /^invoices/ }),
    ).toHaveAttribute("title", "public.invoices");
    expect(await accessibilityViolations(page)).toEqual([]);

    // The base lists them; their rows come from the client's database.
    await page.getByRole("link", { name: "Lab" }).first().click();
    await page.getByRole("link", { name: "invoices", exact: true }).click();
    const grid = page.getByRole("grid");
    await expect(grid.getByRole("gridcell", { name: /^amount: / })).toHaveCount(
      3,
    );
    // Exact numbers, as the client holds them (ADR 0023).
    await expect(
      grid.getByRole("gridcell", {
        name: /99[\s ,.]?999[\s ,.]?999[\s ,.]?999[,.]99/,
      }),
    ).toBeVisible();
    // The foreign key is a link to the customer, by name.
    await expect(
      grid.getByRole("gridcell", { name: "customer_id: Ada" }).first(),
    ).toBeVisible();
    // Read-only: no new row, and cells say so.
    await expect(
      page.getByRole("button", { name: "Add a row", exact: true }),
    ).toHaveCount(0);
    await expect(
      grid.getByRole("gridcell", { name: /^status: / }).first(),
    ).toHaveAttribute("aria-readonly", "true");

    // Search runs in the client's database, on its enumeration too.
    await page.getByLabel("Search this view").fill("draft");
    await expect(grid.getByRole("gridcell", { name: /^amount: / })).toHaveCount(
      1,
    );

    // Writes (ADR 0028): the DBA grants a column, an administrator enables
    // editing on the table, and a cell changes in the client's database.
    const grants = new pg.Client({ connectionString: erpUrl.toString() });
    await grants.connect();
    await grants.query(`grant update (amount) on invoices to ${account}`);
    await grants.end();
    await page.goto("/admin/sources");
    await page
      .getByRole("row", { name: new RegExp(`ERP ${stamp}`) })
      .getByRole("button", { name: "Tables" })
      .click();
    const invoices = dialog
      .getByRole("listitem")
      .filter({ hasText: "public.invoices" });
    // The account may not add rows: that switch stays off.
    await expect(invoices.getByLabel("Add rows")).toBeDisabled();
    const enabled = page.waitForResponse(
      (response) =>
        response.url().includes("admin.sources.setWrites") && response.ok(),
    );
    await invoices.getByLabel("Edit rows").check();
    await enabled;
    await page.keyboard.press("Escape");

    await page.goto("/");
    await page.getByRole("link", { name: "Lab" }).first().click();
    await page.getByRole("link", { name: "invoices", exact: true }).click();
    const amount = grid.getByRole("gridcell", { name: /^amount: 7[,.]25$/ });
    await amount.click();
    const saved = page.waitForResponse(
      (response) => response.url().includes("rows.updateMany") && response.ok(),
    );
    await page.keyboard.type("8");
    await page.keyboard.press("Enter");
    await saved;
    // The status column was not granted: it stays read-only.
    await expect(
      grid.getByRole("gridcell", { name: /^status: / }).first(),
    ).toHaveAttribute("aria-readonly", "true");
    const check = new pg.Client({ connectionString: erpUrl.toString() });
    await check.connect();
    const stored = await check.query<{ amount: string }>(
      "select amount from invoices where id = 1003",
    );
    await check.end();
    expect(stored.rows[0]?.amount).toBe("8.00");
    expect(blocked).toEqual([]);
  } finally {
    // The server's pool still holds connections to the client's database.
    await control.query(`drop database if exists ${database} with (force)`);
    await control.query(`drop role if exists ${account}`);
    await control.end();
  }
});

test("an administrator keeps a new base's tables in a client's database", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const stamp = uniqueStamp();
  const database = `e2e_home_${stamp}`;
  const account = `e2e_holder_${stamp}`;
  const password = "holder-password-e2e";
  const server = new URL(controlUrl);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  const homeUrl = new URL(controlUrl);
  homeUrl.pathname = `/${database}`;
  // Whether a schema is in the client's database, read by its owner.
  const schemas = async (name: string) => {
    const client = new pg.Client({ connectionString: homeUrl.toString() });
    await client.connect();
    try {
      const found = await client.query(
        "select count(*)::int as n from information_schema.schemata where schema_name = $1",
        [name],
      );
      return (found.rows[0] as { n: number }).n;
    } finally {
      await client.end();
    }
  };
  try {
    // The account may create a schema there, and is no superuser.
    await control.query(`create role ${account} login password '${password}'`);
    await control.query(`create database ${database}`);
    await control.query(`grant create on database ${database} to ${account}`);
    const { email } = await signUpWithTable(page, "Admin Home");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    await page.goto("/admin/sources");
    await page.getByRole("button", { name: "Add a source" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("group", { name: "Engine" })
      .getByText("PostgreSQL", { exact: true })
      .click();
    await dialog.getByLabel("Name", { exact: true }).fill(`Home ${stamp}`);
    await dialog.getByLabel("Database", { exact: true }).fill(database);
    await dialog.getByLabel("Host", { exact: true }).fill(server.hostname);
    await dialog.getByLabel("Port", { exact: true }).fill(server.port);
    await dialog.getByLabel("Account", { exact: true }).fill(account);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Save" }).click();
    await proveItIsYou(page);
    await expect(dialog).toBeHidden();

    // A new base whose tables live in that source: no starting point.
    await page.goto("/");
    await page.getByRole("button", { name: "New base" }).first().click();
    await dialog.getByLabel("Base name").fill("Held");
    await dialog
      .getByLabel("Where the tables live")
      .selectOption({ label: `Home ${stamp}` });
    await expect(dialog.getByText("Starting point")).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Held", level: 1 }),
    ).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "Held", exact: true }) })
      .getByRole("button", { name: "Add a table" })
      .click();
    await dialog.getByLabel("Table name").fill("Lines");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const grid = page.getByRole("grid");
    await grid.waitFor();

    // A row added from its form, then typed over in the grid: both land
    // in the client's table.
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    const form = page.getByRole("dialog", { name: "New row" });
    await form.getByLabel("Name", { exact: true }).fill("first line");
    await form.getByRole("button", { name: "Add the row" }).click();
    await expect(form).toBeHidden();
    const cell = grid.locator('[role="gridcell"][data-column="name"]').first();
    await expect(cell).toContainText("first line");
    await cell.click();
    const saved = page.waitForResponse(
      (response) => response.url().includes("rows.updateMany") && response.ok(),
    );
    await page.keyboard.type("edited line");
    await page.keyboard.press("Enter");
    await saved;
    const held = await control.query<{
      schema: string;
      table: string;
    }>(
      `select b.home_schema as schema, t.external_name as table
       from bases b join data_tables t on t.base_id = b.id
       where b.name = 'Held' and t.name = 'Lines'
       order by b.created_at desc limit 1`,
    );
    const { schema, table } = held.rows[0] ?? { schema: "", table: "" };
    await expect
      .poll(async () => {
        const client = new pg.Client({ connectionString: homeUrl.toString() });
        await client.connect();
        try {
          const rows = await client.query(
            `select name from "${schema}"."${table}"`,
          );
          return rows.rows.map((row: { name: string }) => row.name);
        } finally {
          await client.end();
        }
      })
      .toEqual(["edited line"]);

    // Deleted, the base leaves its schema; deleted for good with the
    // schema's name typed, the schema goes too.
    await page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "Held", exact: true }) })
      .getByRole("button", { name: "Base actions" })
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(confirm).toContainText(schema);
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeHidden();
    expect(await schemas(schema)).toBe(1);
    await page.goto("/");
    await page.getByRole("button", { name: "Delete Held permanently" }).click();
    const purge = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    const typed = purge.getByLabel("Schema name, to remove it there too");
    await typed.fill("agnotthisone");
    await purge.getByRole("button", { name: "Delete permanently" }).click();
    await expect(purge).toBeVisible();
    expect(await schemas(schema)).toBe(1);
    await typed.fill(schema);
    await purge.getByRole("button", { name: "Delete permanently" }).click();
    await expect.poll(() => schemas(schema), { timeout: 30_000 }).toBe(0);
    expect(blocked).toEqual([]);
  } finally {
    await control.query(`drop database if exists ${database} with (force)`);
    await control.query(`drop role if exists ${account}`);
    await control.end();
  }
});
