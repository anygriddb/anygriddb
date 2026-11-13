import { expect, test } from "@playwright/test";
import {
  accessibilityViolations,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

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

  await page.getByRole("button", { name: "New view" }).click();
  await expect(page.getByRole("menuitem", { name: "Kanban" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await page.getByRole("button", { name: "Add a row", exact: true }).click();
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
    page.getByRole("button", { name: "Ajouter une ligne", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Ajouter une ligne", exact: true }),
  ).toBeVisible();

  expect(blocked).toEqual([]);
});

// A phone, or a narrow window: the navigation folds away, opens over the
// page from its button, and closes with Escape, giving the page back. It
// makes an account, so it takes a client address of its own: sign-ups are
// counted per address, and the other journeys share theirs.
test.describe("a narrow screen", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.50" } });

  test("the navigation folds away on a narrow screen", async ({ page }) => {
    await signUpWithTable(page, "Narrow User");
    const navigation = page.locator("aside");
    await expect(navigation).toBeInViewport();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(navigation).not.toBeInViewport();
    await expect(page.getByRole("grid")).toBeVisible();

    // The grid's toolbar keeps one line, within the screen: the view's
    // settings fold behind one button, the filter and the search stay.
    const settings = page.getByRole("button", { name: "View settings" });
    await expect(settings).toHaveAttribute("aria-expanded", "false");
    const sort = page.getByRole("button", { name: "Sort", exact: true });
    await expect(sort).toHaveCount(0);
    const middle = async (name: string) => {
      const box = await page.getByRole("button", { name }).boundingBox();
      return box
        ? { y: box.y + box.height / 2, right: box.x + box.width }
        : null;
    };
    const first = await middle("Add a row and open it");
    const last = await middle("More actions");
    expect(last?.y).toBeCloseTo(first?.y ?? 0, 0);
    expect(last?.right).toBeLessThanOrEqual(390);
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    await sort.click();
    await expect(
      page.getByRole("button", { name: "Add a sort" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);

    const open = page.getByRole("button", { name: "Open the navigation" });
    await open.click();
    await expect(navigation).toBeInViewport();
    await expect(
      navigation.getByRole("link", { name: "AnyGridDB" }),
    ).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(navigation).not.toBeInViewport();
    await expect(open).toBeFocused();

    // Going to another page closes it too.
    await open.click();
    await navigation.getByRole("link", { name: "AnyGridDB" }).click();
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
    await expect(navigation).not.toBeInViewport();
  });
});
