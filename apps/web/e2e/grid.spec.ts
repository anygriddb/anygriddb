import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
  accessibilityViolations,
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

  // Grouped, the grid shows every row of its view, past the first 1,000:
  // each header where the database says its group starts, the rows under
  // it read as they scroll. 600 rows to do, then 500 done, then "gamma",
  // which has no status.
  const tableId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
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
  await grid.evaluate((element) => {
    element.scrollTo(0, element.scrollHeight);
  });
  const named = (text: string) =>
    page.locator('[role="gridcell"][data-column="name"]').filter({
      hasText: text,
    });
  await expect(named("n1100")).toBeVisible();
  await expect(named("gamma")).toBeVisible();
  // Folded, a group keeps its header and skips its rows: the next group
  // comes right under it.
  await grid.evaluate((element) => {
    element.scrollTo(0, 0);
  });
  await header("To do").getByRole("button", { name: "Collapse" }).click();
  await expect(header("Done")).toContainText("500");
  await expect(named("n0601")).toBeVisible();
  await expect(named("n0001")).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);

  expect(blocked).toEqual([]);
  expect(blockedOther).toEqual([]);
});

// A number field can refuse values under zero: the grid's editor marks
// such a value and does not send it, and the write itself refuses it
// whatever sends it (`assertCellValue`). It makes an
// account, so it takes a client address of its own: sign-ups are counted
// per address, and the other journeys share theirs.
test.describe("a number field that refuses negatives", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.80" } });

  test("keeps them out of the grid", async ({ page }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Stock Keeper");

    await page.getByRole("button", { name: "Add a field" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Field name").fill("Stock");
    await dialog.getByLabel("Type").selectOption("number");
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
    expect(blocked).toEqual([]);
  });
});
