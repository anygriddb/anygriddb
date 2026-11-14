import { readFile } from "node:fs/promises";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
  accessibilityViolations,
  pickFieldType,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

const nameCell = (page: Page) =>
  page.locator('[role="gridcell"][data-column="name"]').first();

/** Types `text` into the first name cell and waits for the save. */
async function typeName(page: Page, text: string) {
  await nameCell(page).click();
  const saved = page.waitForResponse(
    (response) => response.url().includes("rows.updateMany") && response.ok(),
  );
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await saved;
}

test("signup, second factor, base, table, then a typed cell survives a reload", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "E2E User");

  await page.getByRole("button", { name: "Add a row", exact: true }).click();
  const cell = page.locator('[role="gridcell"][data-column="name"]').first();
  await cell.click();

  // ARIA grid: focus stays on the grid, which names its active cell; the
  // arrows move that cell, and the selection follows.
  const grid = page.getByRole("grid");
  await expect(grid).toBeFocused();
  const first = await grid.getAttribute("aria-activedescendant");
  expect(first).toBeTruthy();
  await expect(page.locator(`[id="${first ?? ""}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await expect(grid).not.toHaveAttribute("aria-activedescendant", first ?? "");
  await page.keyboard.press("ArrowLeft");
  await expect(grid).toHaveAttribute("aria-activedescendant", first ?? "");
  const saved = page.waitForResponse(
    (response) => response.url().includes("rows.updateMany") && response.ok(),
  );
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await saved;

  await page.reload();
  await expect(nameCell(page)).toContainText("alpha");

  // Realtime (ADR 0049). A second tab on the table: its link to the
  // server goes through this route, which the journey can cut.
  const other = await page.context().newPage();
  const blockedOther = watchPolicy(other);
  let cutOff = false;
  const links: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
  await other.routeWebSocket(/\/ws$/, (route) => {
    if (cutOff) {
      void route.close({ code: 1000 });
      return;
    }
    links.push({ page: route, server: route.connectToServer() });
  });
  await other.goto(page.url());
  await expect(nameCell(other)).toContainText("alpha");

  // A change in one tab shows in the other, without a reload.
  await typeName(page, "beta");
  await expect(nameCell(other)).toContainText("beta");

  // Cut off, the other tab misses the next change, and says so after 10 s.
  cutOff = true;
  for (const link of links.splice(0)) {
    await link.server.close();
    await link.page.close({ code: 1000 });
  }
  await typeName(page, "gamma");
  const banner = other.getByRole("status").filter({
    hasText: "Connection lost",
  });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(nameCell(other)).toContainText("beta");
  expect(await accessibilityViolations(other)).toEqual([]);

  // Back: it re-reads what it shows, still without a reload.
  cutOff = false;
  await banner.getByRole("button", { name: "Reconnect now" }).click();
  await expect(banner).toBeHidden();
  await expect(nameCell(other)).toContainText("gamma");
  await other.close();

  // Rows keep the order people give them (ADR 0060): a row inserted above
  // another, a row moved up from its menu, the move undone.
  const names = page.locator('[role="gridcell"][data-column="name"]');
  await names.first().click({ button: "right" });
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.getByRole("menuitem", { name: "Insert a row above" }).click();
  await expect(names).toHaveCount(2);
  await expect(names.nth(1)).toContainText("gamma");
  await names.nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move the row up" }).click();
  await expect(names.first()).toContainText("gamma");
  await names.first().click();
  await page.keyboard.press("Control+z");
  await expect(names.nth(1)).toContainText("gamma");
  // The empty row goes, so the grouping below counts what it did before.
  await names.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete rows" }).click();
  await expect(names).toHaveCount(1);
  await expect(nameCell(page)).toContainText("gamma");

  // Grouped, the grid shows every row of its view, past the first 1,000:
  // each header where the database says its group starts, the rows under
  // it read as they scroll. 600 rows to do, then 500 done, then "gamma",
  // which has no status.
  const tableId = /\/t\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1] ?? "";
  const added = Array.from({ length: 1100 }, (_, index) => ({
    name: `n${String(index + 1).padStart(4, "0")}`,
    status: index < 600 ? "To do" : "Done",
  }));
  for (let start = 0; start < added.length; start += 500) {
    const status = await page.evaluate(
      async ([tableId, rows]) =>
        (
          await fetch("/trpc/rows.insertMany", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tableId, rows }),
          })
        ).status,
      [tableId, added.slice(start, start + 500)] as const,
    );
    expect(status).toBe(200);
  }
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Add a level" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Field", { exact: true })
    .selectOption({ label: "Status" });
  await page.keyboard.press("Escape");
  const header = (label: string) =>
    grid
      .locator('[role="row"]')
      .filter({ has: page.locator("button[aria-expanded]") })
      .filter({ hasText: label });
  await expect(header("To do")).toContainText("600");
  const named = (text: string) =>
    page.locator('[role="gridcell"][data-column="name"]').filter({
      hasText: text,
    });
  // The grid measures its rows as they are drawn: scroll again until the
  // end stays in view.
  await expect(async () => {
    await grid.evaluate((element) => {
      element.scrollTo(0, element.scrollHeight);
    });
    await expect(named("n1100")).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await expect(named("gamma")).toBeVisible();
  // Folded, a group keeps its header and skips its rows: the next group
  // comes right under it.
  await grid.evaluate((element) => {
    element.scrollTo(0, 0);
  });
  const fold = header("To do").locator("button[aria-expanded]");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(header("Done")).toContainText("500");
  await expect(named("n0601")).toBeVisible();
  await expect(named("n0001")).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);

  // The home page picks up where the person left off: the table, how many
  // rows it holds, and who changed it last.
  await page.goto("/");
  const pickUp = page.getByRole("region", {
    name: "Pick up where you left off",
  });
  const samples = pickUp.getByRole("link", { name: /Samples/ });
  await expect(samples).toContainText(/rows/);
  await expect(samples).toContainText(/Changed .* by you/);
  await expect(page.getByRole("region", { name: "For you" })).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  expect(blocked).toEqual([]);
  expect(blockedOther).toEqual([]);
});

// A number field can refuse values under zero: the grid's editor marks
// such a value and does not send it, and the write itself refuses it
// whatever sends it (`assertCellValue`). Made required, it is filled
// before a row is added and never emptied. It makes an
// account, so it takes a client address of its own: sign-ups are counted
// per address, and the other journeys share theirs.
test.describe("a number field that refuses negatives, then empties", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.80" } });

  test("keeps them out of the grid", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Stock Keeper");

    await page.getByRole("button", { name: "Add a field" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Field name").fill("Stock");
    await pickFieldType(page, dialog, "Number");
    await dialog.getByLabel("Refuse negative numbers").check();
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    const stock = page
      .locator('[role="gridcell"][data-column="stock"]')
      .first();
    await stock.click();
    await page.keyboard.type("-5");
    await page.keyboard.press("Enter");
    // The editor marks the value and keeps it out: nothing is written.
    const editor = page.getByRole("textbox", { name: "Stock" });
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(stock).not.toContainText("5");

    await stock.click();
    const saved = page.waitForResponse(
      (response) => response.url().includes("rows.updateMany") && response.ok(),
    );
    await page.keyboard.type("5");
    await page.keyboard.press("Enter");
    await saved;
    await page.reload();
    await expect(
      page.locator('[role="gridcell"][data-column="stock"]').first(),
    ).toContainText("5");
    await expect(
      page.locator('[role="gridcell"][data-column="stock"]').first(),
    ).not.toContainText("-");

    // Required: a new row is filled before it is added, and no write
    // empties the field, the row from before included.
    await page.getByRole("button", { name: "Stock field menu" }).click();
    await page.getByRole("menuitem", { name: "Edit field" }).click();
    await dialog.getByLabel("Require a value in every row").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("columnheader", { name: /Stock ?, Value required/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    const newRow = page.getByRole("dialog", { name: "New row" });
    await newRow.getByRole("button", { name: "Add the row" }).click();
    await expect(page.getByText("“Stock” is required")).toBeVisible();
    await expect(newRow.getByLabel("Stock")).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(await accessibilityViolations(page)).toEqual([]);
    await newRow.getByLabel("Stock").fill("3");
    await newRow.getByRole("button", { name: "Add the row" }).click();
    await expect(newRow).toBeHidden();
    const cells = page.locator('[role="gridcell"][data-column="stock"]');
    await expect(cells).toHaveCount(2);
    await expect(cells.nth(1)).toContainText("3");
    await cells.first().click();
    await page.keyboard.press("Delete");
    await expect(page.getByText("A value is required: Stock")).toBeVisible();
    await page.reload();
    await expect(cells.first()).toContainText("5");

    // The row's id as a field (ADR 0063): each row shows the id the API
    // takes, and no editor opens on it.
    await page.getByRole("button", { name: "Add a field" }).click();
    await dialog.getByLabel("Field name").fill("Ref");
    await pickFieldType(page, dialog, "Row id");
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog).toBeHidden();
    const refs = page.locator('[role="gridcell"][data-column="ref"]');
    await expect(refs).toHaveCount(2);
    await expect(refs.first()).toContainText(
      /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    await refs.first().dblclick();
    await expect(page.getByRole("textbox", { name: "Ref" })).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(blocked).toEqual([]);
  });
});

// A file of more rows than one batch of the import (ADR 0064): read from
// disk as its rows are written, every line arrives, and a key that comes
// back in a later batch updates the row an earlier one added. It makes an
// account, so it takes a client address of its own.
test.describe("a file of more rows than one batch", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.81" } });

  test("is imported line for line", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Ida Importer");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Import a file" }).click();
    const dialog = page.getByRole("dialog", { name: "Import rows" });
    const lines = Array.from(
      { length: 1_200 },
      (_, index) => `Item ${index + 1},first`,
    );
    lines.push("Item 3,again");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "items.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`Name,Notes\n${lines.join("\n")}\n`),
    });
    await expect(
      dialog.getByText(/items\.csv: 1,?201 rows found\./),
    ).toBeVisible();
    await dialog
      .getByLabel("Existing rows")
      .selectOption({ label: "Update when “Name” matches" });
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: /Import 1,?201 rows/ }).click();
    await expect(
      dialog.getByText(/1,?200 rows added, 1 updated, 0 rejected\./),
    ).toBeVisible({ timeout: 60_000 });
    // The button under the report, not the dialog's cross.
    await dialog
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" })
      .click();
    await expect(dialog).toBeHidden();
    await page.getByLabel("Search this view").fill("Item 3");
    const notes = page.locator('[role="gridcell"][data-column="notes"]');
    await expect(notes.first()).toContainText("again");
    expect(blocked).toEqual([]);
  });
});

// A restore point keeps the base as it was (ADR 0077): restored, it comes
// back as a new base beside the first, which keeps what was written since.
// It makes an account, so it takes a client address of its own.
test.describe("a restore point", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.82" } });

  test("brings the base back as it was, beside it", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Rhea Restorer");
    const table = page.url();
    const base = /\/b\/[^/]+/.exec(table)?.[0] ?? "";
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    await typeName(page, "Before");

    await page.goto(`${base}/settings`);
    await page.getByLabel("Note (optional)").fill("Before the change");
    await page.getByRole("button", { name: "Make a restore point" }).click();
    await expect(
      page.getByText("Restore point made", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const point = page
      .getByRole("listitem")
      .filter({ hasText: "Before the change" });
    await expect(point).toContainText("1 row");
    // Its size, in the binary units of the reader's language.
    await expect(point).toContainText(/ \d+(\.\d)? (B|KiB) · kept until /);
    expect(await accessibilityViolations(page)).toEqual([]);

    // Written after the point: the restore does not take it away.
    await page.goto(table);
    await typeName(page, "After");

    await page.goto(`${base}/settings`);
    await point.getByRole("button", { name: "Restore as a new base" }).click();
    await expect(page.getByText("Base restored, beside this one")).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Lab (restored)" }),
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Tables" })
      .getByRole("link", { name: /Samples/ })
      .click();
    await expect(nameCell(page)).toContainText("Before");

    await page.goto(table);
    await expect(nameCell(page)).toContainText("After");
    expect(blocked).toEqual([]);
  });
});

// A workbook made a base (ADR 0078): a table exported as .xlsx comes back
// as a new base, its sheet a table with the same rows. It makes an
// account, so it takes a client address of its own.
test.describe("a workbook", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.83" } });

  test("becomes a base, each sheet kept a table", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Wendy Workbook");
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    await typeName(page, "Alpha");
    const tableId = /\/t\/([^/]+)/.exec(page.url())?.[1] ?? "";
    const bytes = await page.evaluate(async (id) => {
      const response = await fetch(
        `/api/export/${id}?format=xlsx&timeZone=UTC`,
      );
      return [...new Uint8Array(await response.arrayBuffer())];
    }, tableId);

    await page.getByRole("button", { name: "New base" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New base" });
    await dialog
      .getByRole("button", { name: "from a spreadsheet (.xlsx)" })
      .click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "Samples.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(bytes),
    });
    await expect(
      dialog.getByRole("checkbox", { name: /Samples/ }),
    ).toBeChecked();
    await expect(dialog.getByLabel("Base name")).toHaveValue("Samples");
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Import" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Samples", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole("region", { name: "Tables" })
      .getByRole("link", { name: /Samples/ })
      .click();
    await expect(nameCell(page)).toContainText("Alpha");
    expect(blocked).toEqual([]);
  });
});

// A gallery, a timeline, and a kanban's stacks read their rows as they
// scroll, and a map only the rows that have a place: none stops at a first
// page. A setting saved does not read the rows again. It makes an account,
// so it takes a client address of its own.
test.describe("a gallery, a timeline, a kanban, and a map past their first page", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.81" } });

  test("show every card, and every row that has a place", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Gallery Keeper");
    const tableId =
      /\/t\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1] ?? "";
    for (const [name, fieldType] of [
      ["lat", "number"],
      ["lon", "number"],
      ["due", "date"],
    ] as const) {
      const status = await page.evaluate(
        async ([tableId, name, fieldType]) =>
          (
            await fetch("/trpc/catalog.addColumn", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tableId, name, fieldType }),
            })
          ).status,
        [tableId, name, fieldType] as const,
      );
      expect(status).toBe(200);
    }
    // 1,100 cards, all due this month; the first 1,050 to do, and only the
    // last 100 have a place.
    const now = new Date();
    const due = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-15`;
    const added = Array.from({ length: 1100 }, (_, index) => ({
      name: `c${String(index + 1).padStart(4, "0")}`,
      due,
      ...(index < 1050 ? { status: "To do" } : {}),
      ...(index >= 1000
        ? { lat: String(40 + (index - 1000) / 10), lon: "2.35" }
        : {}),
    }));
    for (let start = 0; start < added.length; start += 500) {
      const status = await page.evaluate(
        async ([tableId, rows]) =>
          (
            await fetch("/trpc/rows.insertMany", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tableId, rows }),
            })
          ).status,
        [tableId, added.slice(start, start + 500)] as const,
      );
      expect(status).toBe(200);
    }

    // An export job writes every row to its file as it reads them, then
    // the file downloads.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Export view as CSV" }).click();
    const exported = await readFile(
      (await (await download).path()) ?? "",
      "utf8",
    );
    const lines = exported.split("\n");
    expect(lines).toHaveLength(1_101);
    expect(lines.at(-1)).toContain("c1100");

    const newView = async (type: string) => {
      await page.getByRole("button", { name: "New view" }).click();
      await page.getByRole("menuitem", { name: type }).first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create", exact: true })
        .click();
    };
    const card = (name: string) =>
      page.getByRole("button", { name: new RegExp(`^${name}`) });

    await newView("Gallery");
    await expect(card("c0001")).toBeVisible();
    const gallery = card("c0001").locator(
      "xpath=ancestor::div[contains(@class, 'overflow-y-auto')]",
    );
    await expect(async () => {
      await gallery.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
      });
      await expect(card("c1100")).toBeVisible({ timeout: 2_000 });
    }).toPass();
    expect(await accessibilityViolations(page)).toEqual([]);

    // Sorted, the cards are read once, with the setting kept locally: its
    // save reads nothing more.
    let viewsAfterSave = false;
    let readsAfterSave = 0;
    let saving = false;
    page.on("response", (response) => {
      if (response.url().includes("catalog.updateView")) saving = true;
      else if (saving && response.url().includes("catalog.views")) {
        viewsAfterSave = true;
      }
    });
    page.on("request", (request) => {
      if (viewsAfterSave && request.url().includes("rows.read")) {
        readsAfterSave += 1;
      }
    });
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    const sorted = page.waitForResponse(
      (response) =>
        response.url().includes("catalog.updateView") && response.ok(),
    );
    await page.getByRole("button", { name: "Add a sort" }).click();
    await sorted;
    saving = false;
    viewsAfterSave = false;
    const reversed = page.waitForResponse(
      (response) =>
        response.url().includes("catalog.updateView") && response.ok(),
    );
    await page.getByLabel("Order").selectOption("desc");
    await reversed;
    await page.keyboard.press("Escape");
    await expect(card("c1100")).toBeVisible();
    await expect.poll(() => viewsAfterSave).toBe(true);
    await page.waitForTimeout(1_000);
    expect(readsAfterSave).toBe(0);

    // The map reads the rows that have a place, past the first 1,000.
    await newView("Map");
    await expect(page.getByText("100 points")).toBeVisible();
    await expect(page.getByRole("button", { name: "c1001" })).toBeVisible();
    await expect(page.getByRole("button", { name: "c1100" })).toBeVisible();
    await expect(page.getByRole("button", { name: "c0001" })).toHaveCount(0);
    await expect(page.locator('span[title="c1100"]')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // The timeline reads every row of the period it shows, as it scrolls,
    // and none of the period before.
    await newView("Timeline");
    await expect(card("c0001").first()).toBeVisible();
    const timeline = card("c0001")
      .first()
      .locator("xpath=ancestor::div[contains(@class, 'overflow-auto')]");
    await expect(async () => {
      await timeline.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
      });
      await expect(card("c1100").first()).toBeVisible({ timeout: 2_000 });
    }).toPass();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Previous period" }).click();
    await expect(page.getByText("No rows in this period.")).toBeVisible();
    await page.getByRole("button", { name: "Today" }).click();
    await expect(card("c0001").first()).toBeVisible();

    // A kanban's stack reads every card it counts, as it scrolls; a card
    // changed elsewhere moves to its new stack.
    await newView("Kanban");
    const todo = page.getByRole("region", { name: "To do" });
    await expect(todo.getByText("1,050", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "No value" }).getByText("50", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(todo.getByRole("button", { name: /^c0001/ })).toBeVisible();
    const stack = todo.locator("div.overflow-y-auto");
    await expect(async () => {
      await stack.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
      });
      await expect(todo.getByRole("button", { name: /^c1050/ })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass();
    expect(await accessibilityViolations(page)).toEqual([]);
    const first = await page.evaluate(
      async ([tableId]) => {
        const response = await fetch(
          `/trpc/rows.read?input=${encodeURIComponent(
            JSON.stringify({ tableId, limit: 1, search: "c0001" }),
          )}`,
        );
        const body = (await response.json()) as {
          result: { data: { rows: Array<{ id: string }> } };
        };
        return body.result.data.rows[0]?.id ?? "";
      },
      [tableId] as const,
    );
    const moved = await page.evaluate(
      async ([tableId, rowId]) =>
        (
          await fetch("/trpc/rows.updateMany", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tableId,
              updates: [{ rowId, values: { status: "Done" } }],
            }),
          })
        ).status,
      [tableId, first] as const,
    );
    expect(moved).toBe(200);
    const done = page.getByRole("region", { name: "Done" });
    await expect(done.getByRole("button", { name: /^c0001/ })).toBeVisible();
    await expect(todo.getByText("1,049", { exact: true })).toBeVisible();

    expect(blocked).toEqual([]);
  });
});
