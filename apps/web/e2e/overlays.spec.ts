import { expect, test } from "@playwright/test";
import { signUpWithTable, watchPolicy } from "./setup.ts";

// Menus, popovers, and dialogs by keyboard (ADR 0012): each opens with its
// role, moves focus into itself, and closes with Escape.
test("menus, submenus, a context menu, and a popover work from the keyboard", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Menu User");

  await page.getByRole("button", { name: "Menu User" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Theme" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("menu")).toBeHidden();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Shared view" }).getByRole("menuitem", {
      name: "Kanban",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await page.getByRole("button", { name: "Add a row" }).click();
  await page
    .locator('[role="gridcell"][data-column="name"]')
    .first()
    .click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions" });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toBeHidden();

  await page
    .getByRole("button", { name: /Filter/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // French catalog loads; the chrome follows; the choice survives reload.
  await page.getByRole("button", { name: "Menu User" }).click();
  await page.getByRole("menuitem", { name: "Language" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Français" }).click();
  await expect(
    page.getByRole("button", { name: "Ajouter une ligne" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Ajouter une ligne" }),
  ).toBeVisible();

  expect(blocked).toEqual([]);
});
