import { expect, test, type Page } from "@playwright/test";
import {
  accessibilityViolations,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

/** Adds a field to the open table through the API, as the app does. */
async function addField(
  page: Page,
  tableId: string,
  field: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.post("/trpc/catalog.addColumn", {
    data: { tableId, ...field },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** The values a cell edit sends, once the API has taken them. */
function savedValues(page: Page) {
  return page
    .waitForRequest((request) => request.url().includes("rows.updateMany"))
    .then((request) => request.postData() ?? "");
}

const cell = (page: Page, column: string) =>
  page.locator(`[role="gridcell"][data-column="${column}"]`).first();

// Cell editors on React Aria (ADR 0012): dates in segments and a
// calendar, lists filtered by typing and walked with the arrows, a
// rating as a spin button; every one ends with Enter, Tab, or Escape.
test("dates, lists, and ratings are edited from the keyboard", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Editor User");
  const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  await addField(page, tableId, {
    name: "due",
    label: "Due",
    fieldType: "date",
  });
  await addField(page, tableId, {
    name: "meeting",
    label: "Meeting",
    fieldType: "datetime",
    config: { date: { timeZone: "America/New_York" } },
  });
  await addField(page, tableId, {
    name: "stage",
    label: "Stage",
    fieldType: "single_select",
    options: ["Lead", "Won", "Lost"],
  });
  await addField(page, tableId, {
    name: "tags",
    label: "Tags",
    fieldType: "multi_select",
    options: ["Red", "Green", "Blue"],
  });
  await addField(page, tableId, {
    name: "score",
    label: "Score",
    fieldType: "rating",
    config: { ratingMax: 5 },
  });
  await page.reload();
  await page.getByRole("button", { name: "Add a row", exact: true }).click();
  const grid = page.getByRole("grid");

  // A date typed from the grid: the first key opens the editor and goes
  // into the day, the next ones fill the month and the year.
  await cell(page, "due").click();
  let saved = savedValues(page);
  await page.keyboard.type("14032026");
  await expect(
    page.getByRole("spinbutton", { name: /day/i }).first(),
  ).toHaveText("14");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"due":"2026-03-14"');
  await expect(cell(page, "due")).toContainText("14/03/2026");
  await expect(grid).toBeFocused();

  // The calendar: Alt+ArrowDown opens it on the cell's day, the arrows
  // walk the days, Enter picks one, and the cell keeps it.
  await cell(page, "due").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Alt+ArrowDown");
  const calendar = page.getByRole("dialog");
  await expect(calendar.getByRole("grid")).toBeVisible();
  await expect(calendar.getByRole("heading")).toHaveText("March 2026");
  saved = savedValues(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"due":"2026-03-20"');
  await expect(cell(page, "due")).toContainText("20/03/2026");

  // A date and time in its field's zone, not the reader's.
  await cell(page, "meeting").click();
  saved = savedValues(page);
  await page.keyboard.type("140320261030");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"meeting":"2026-03-14T14:30:00.000Z"');

  // Escape leaves the value as it was.
  await cell(page, "due").click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("01");
  await page.keyboard.press("Escape");
  await expect(cell(page, "due")).toContainText("20/03/2026");

  // A single option: typed to filter, the first match is picked by Enter.
  await cell(page, "stage").click();
  await page.keyboard.press("Enter");
  const search = page.getByRole("textbox", { name: "Search an option" });
  await expect(search).toBeFocused();
  saved = savedValues(page);
  await page.keyboard.type("wo");
  await expect(page.getByRole("option", { name: "Won" })).toBeVisible();
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"stage":"Won"');
  await expect(cell(page, "stage")).toContainText("Won");

  // Several options: the arrows move, Enter toggles, Escape closes.
  await cell(page, "tags").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  saved = savedValues(page);
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"tags":["Red"]');
  await page.keyboard.press("ArrowDown");
  saved = savedValues(page);
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"tags":["Red","Green"]');
  await expect(page.getByRole("option", { name: "Red" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(cell(page, "tags")).toContainText("Green");

  // A rating: typed, then raised with the arrow.
  await cell(page, "score").click();
  saved = savedValues(page);
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"score":3');
  await cell(page, "score").click();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Score" })).toBeFocused();
  saved = savedValues(page);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"score":4');

  expect(blocked).toEqual([]);
});

// The record panel and a form from the keyboard, and checked by axe
// (WCAG 2.2 AA) with an editor open, as a screen reader would meet them.
test("the grid, the record panel, and a form pass axe and work by keyboard", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Panel User");
  const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  await addField(page, tableId, {
    name: "due",
    label: "Due",
    fieldType: "date",
  });
  await addField(page, tableId, {
    name: "done",
    label: "Done",
    fieldType: "boolean",
  });
  await addField(page, tableId, {
    name: "stage",
    label: "Stage",
    fieldType: "single_select",
    options: ["Lead", "Won"],
  });
  await page.reload();
  await page.getByRole("button", { name: "Add a row", exact: true }).click();
  await expect(page.getByText(/Saved at/)).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await cell(page, "due").click();
  await page.keyboard.press("Enter");
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await cell(page, "stage").click();
  await page.keyboard.press("Enter");
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");

  // Space opens the row; each field has its button, and focus comes back
  // to it when the edit ends.
  await page.keyboard.press(" ");
  const panel = page.getByRole("complementary", { name: "Row details" });
  await expect(panel).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  const editDue = panel.getByRole("button", { name: "Edit Due" });
  await editDue.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("spinbutton", { name: /day/i })).toBeFocused();
  expect(await accessibilityViolations(page)).toEqual([]);
  let saved = savedValues(page);
  await page.keyboard.type("14032026");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"due":"2026-03-14"');
  await expect(editDue).toBeFocused();

  const done = panel.getByRole("checkbox", { name: "Done" });
  await done.focus();
  saved = savedValues(page);
  await page.keyboard.press(" ");
  expect(await saved).toContain('"done":true');
  await expect(done).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // A form: its date field is named by its label and filled by keyboard.
  await page.getByRole("button", { name: "New view" }).click();
  await page
    .getByRole("group", { name: "Shared view" })
    .getByRole("menuitem", { name: "Form" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const due = page.getByRole("group", { name: "Due" });
  await expect(due).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await due.getByRole("spinbutton").first().focus();
  await page.keyboard.type("15032026");
  const inserted = page.waitForRequest((request) =>
    request.url().includes("rows.insert"),
  );
  await page.getByRole("button", { name: "Submit" }).click();
  expect((await inserted).postData() ?? "").toContain('"due":"2026-03-15"');

  expect(blocked).toEqual([]);
});
