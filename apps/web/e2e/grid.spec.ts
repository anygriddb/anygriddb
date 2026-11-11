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

  expect(blocked).toEqual([]);
  expect(blockedOther).toEqual([]);
});
