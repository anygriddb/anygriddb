import { expect, test } from "@playwright/test";
import { signUpWithTable, watchPolicy } from "./setup.ts";

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
  await expect(
    page.locator('[role="gridcell"][data-column="name"]').first(),
  ).toContainText("alpha");
  expect(blocked).toEqual([]);
});
