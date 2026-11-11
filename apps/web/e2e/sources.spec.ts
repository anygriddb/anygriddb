import { expect, test } from "@playwright/test";
import pg from "pg";
import {
  accessibilityViolations,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

// The journey's PostgreSQL holds AnyGridDB's catalog and, beside it, a
// client's database with an account of its own (ADR 0026).
const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

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

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Sources" }).click();
    await page.getByRole("button", { name: "Declare a source" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(`ERP ${stamp}`);
    // Exact names: the read replica's fields are named after these.
    await dialog.getByLabel("Database", { exact: true }).fill(database);
    await dialog.getByLabel("Host", { exact: true }).fill(server.hostname);
    await dialog.getByLabel("Port", { exact: true }).fill(server.port);
    await dialog.getByLabel("Account", { exact: true }).fill(account);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Save" }).click();
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
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Sources" }).click();
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
