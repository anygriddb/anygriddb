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
    await signUpWithTable(page, "Narrow User", { gridTips: true });
    const navigation = page.locator("aside");
    await expect(navigation).toBeInViewport();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(navigation).not.toBeInViewport();
    // A phone has no room for a grid's columns: its rows are cards.
    const cards = page.getByRole("list", { name: "Rows" });
    await expect(cards).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);

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

    // A row opens over the whole page, which waits under it until Escape.
    await page.getByRole("button", { name: "Add a row and open it" }).click();
    const row = page.getByRole("dialog", { name: "Row details" });
    await expect(row).toBeInViewport();
    expect(
      await cards.evaluate((list) => list.closest("[inert]") !== null),
    ).toBe(true);
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(
        await row.evaluate((dialog) => dialog.contains(document.activeElement)),
      ).toBe(true);
    }
    expect(await accessibilityViolations(page)).toEqual([]);
    await row.getByRole("button", { name: "Close", exact: true }).click();
    await expect(row).toHaveCount(0);

    // A first visit's tip names the gesture a phone has: no keys there.
    const tip = page.getByRole("region", {
      name: "Tap a card to open the row.",
    });
    await expect(tip).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await tip.getByRole("button", { name: "Hide the tips" }).click();
    await expect(tip).toHaveCount(0);

    // The row is a card, which opens it; the last card adds one.
    const items = cards.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await items.first().getByRole("button").click();
    await expect(row).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(row).toHaveCount(0);
    await cards.getByRole("button", { name: "Add a row", exact: true }).click();
    await expect(row).toBeInViewport();
    await row.getByRole("button", { name: "Close", exact: true }).click();
    await expect(items).toHaveCount(3);
    expect(await accessibilityViolations(page)).toEqual([]);

    // A new row asked for first, and a form's fields, cover the screen.
    const baseId = /\/b\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    const made = await page.request.post("/trpc/catalog.createTable", {
      data: {
        baseId,
        name: "Requests",
        columns: [
          { name: "title", label: "Title", fieldType: "text", required: true },
        ],
      },
    });
    expect(made.ok(), await made.text()).toBe(true);
    const tableId = (
      (await made.json()) as { result: { data: { id: string } } }
    ).result.data.id;
    const formView = await page.request.post("/trpc/catalog.createView", {
      data: { tableId, name: "Request form", viewType: "form" },
    });
    expect(formView.ok(), await formView.text()).toBe(true);
    const viewId = (
      (await formView.json()) as { result: { data: { id: string } } }
    ).result.data.id;
    const whole = { x: 0, y: 0, width: 390, height: 844 };
    await page.goto(`/b/${baseId}/t/${tableId}`);
    await cards.getByRole("button", { name: "Add a row", exact: true }).click();
    const newRow = page.getByRole("dialog", { name: "New row" });
    await expect(newRow.getByLabel("Title")).toBeVisible();
    expect(await newRow.boundingBox()).toEqual(whole);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(newRow).toHaveCount(0);
    await page.goto(`/b/${baseId}/t/${tableId}/${viewId}`);
    await page.getByRole("button", { name: "Form fields" }).click();
    const fields = page.getByRole("dialog", { name: "Form fields" });
    await expect(fields.getByLabel("Submit button label")).toBeVisible();
    expect(await fields.boundingBox()).toEqual(whole);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(fields).toHaveCount(0);

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
