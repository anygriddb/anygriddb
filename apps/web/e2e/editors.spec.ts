import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import {
  accessibilityViolations,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

// Where the journeys' own PostgreSQL listens (`scripts/e2e.sh`).
const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

/** Sends a change to the API with the page's session, as the app does. */
async function send(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.post(`/trpc/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Adds a field to the open table through the API, as the app does. */
async function addField(
  page: Page,
  tableId: string,
  field: Record<string, unknown>,
): Promise<void> {
  await send(page, "catalog.addColumn", { tableId, ...field });
}

/** The values a cell edit sends, once the API has taken them. */
function savedValues(page: Page) {
  return page
    .waitForRequest((request) => request.url().includes("rows.updateMany"))
    .then((request) => request.postData() ?? "");
}

const cell = (page: Page, column: string) =>
  page.locator(`[role="gridcell"][data-column="${column}"]`).first();

// Cell editors: dates in segments and a calendar, lists filtered by
// typing and walked with the arrows, a rating as a slider of icons;
// every one ends with Enter, Tab, or Escape.
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

  // A rating: typed, then raised with the arrow on the icon slider.
  await cell(page, "score").click();
  saved = savedValues(page);
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"score":3');
  await cell(page, "score").click();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("slider", { name: "Score" })).toBeFocused();
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
    name: "tag",
    label: "Tag",
    fieldType: "text",
  });
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
  // A link drawn as a QR code, and a row whose texts the codes hold.
  await addField(page, tableId, {
    name: "page",
    label: "Page",
    fieldType: "url",
    config: { appearance: "qr" },
  });
  await send(page, "rows.insert", {
    tableId,
    values: { tag: "LOT-0042", page: "https://example.org/s/42" },
  });
  await page.reload();

  // A text is set to be drawn as a barcode from its field's settings.
  await page.getByRole("button", { name: "Tag field menu" }).click();
  await page.getByRole("menuitem", { name: "Edit field" }).click();
  const settings = page.getByRole("dialog");
  await settings.getByLabel("Display").selectOption("Barcode");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();

  // The sidebar is resized by keyboard and keeps its width; by a drag too.
  const resize = page.getByRole("separator", { name: "Resize the sidebar" });
  await resize.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "272");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "272");
  const strip = await resize.boundingBox();
  if (!strip) throw new Error("the sidebar has no resize strip");
  await page.mouse.move(strip.x + strip.width / 2, strip.y + 300);
  await page.mouse.down();
  await page.mouse.move(strip.x + strip.width / 2 + 50, strip.y + 300, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "322");
  await resize.focus();
  await page.keyboard.press("Enter");
  await expect(resize).toHaveAttribute("aria-valuenow", "240");

  // A column is resized by dragging its edge.
  const dueHeader = page.getByRole("columnheader", { name: /Due/ });
  const before = (await dueHeader.boundingBox())?.width ?? 0;
  const edge = await dueHeader
    .getByRole("separator", { name: "Resize", exact: true })
    .boundingBox();
  if (!edge) throw new Error("the column has no resize edge");
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    edge.x + edge.width / 2 + 40,
    edge.y + edge.height / 2,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await dueHeader.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 30);

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
  // The row's codes are drawn there, each named by the text it holds.
  await expect(
    panel.getByRole("img", { name: "Barcode of LOT-0042" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("img", { name: "QR code of https://example.org/s/42" }),
  ).toBeVisible();
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

  // Tab moves along a row; past its last field it leaves the grid, and
  // Shift Tab before its first leaves it backward, past the controls the
  // grid holds: the keyboard is never held in it (WCAG 2.1.2).
  const grid = page.getByRole("grid");
  const focusInGrid = () =>
    grid.evaluate((element) => element.contains(document.activeElement));
  await cell(page, "due").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  expect(await focusInGrid()).toBe(false);
  await cell(page, "due").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+Tab");
  expect(await focusInGrid()).toBe(false);
  await cell(page, "due").click();
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();

  // A map on a table with no number field says what it needs, rather than
  // an empty sheet.
  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("menuitem", { name: "Map" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByText("Add a place field, or two number fields"),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  // A form: its date field is named by its label and filled by keyboard.
  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("menuitem", { name: "Form" }).click();
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

// A colour and a place (ROADMAP #95): each typed as a person types it and
// kept in its one spelling. The grid draws the colour with its swatch, its
// picker writes the same cell, and a map reads the place with no field to
// choose.
// It makes an account, so it takes a client address of its own: sign-ups
// are counted per address, and the other journeys share theirs.
test.describe("a colour and a place", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.91" } });

  test("a colour is typed or picked, and a map reads a place", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Place User");
    const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    await addField(page, tableId, {
      name: "tint",
      label: "Tint",
      fieldType: "color",
    });
    await addField(page, tableId, {
      name: "spot",
      label: "Spot",
      fieldType: "place",
    });
    await send(page, "rows.insertMany", {
      tableId,
      rows: [{ name: "Paris" }, { name: "Nowhere" }],
    });
    await page.reload();
    await page.getByRole("grid").waitFor();

    // Three digits and capitals: kept as six, in lower case.
    let saved = savedValues(page);
    await cell(page, "tint").click();
    await page.keyboard.type("#ABC");
    await page.keyboard.press("Enter");
    expect(await saved).toContain('"tint":"#aabbcc"');
    await expect(cell(page, "tint")).toContainText("#aabbcc");
    // What is no colour is refused, and the cell keeps what it had.
    await cell(page, "tint").click();
    await page.keyboard.type("blue");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Invalid value for Tint")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cell(page, "tint")).toContainText("#aabbcc");
    // The picker writes the same cell, and going to it does not end the edit.
    saved = savedValues(page);
    await cell(page, "tint").click();
    await page.keyboard.press("Enter");
    const picker = page.getByLabel("Pick a colour");
    await expect(picker).toHaveValue("#aabbcc");
    await picker.fill("#1f3fae");
    await picker.press("Enter");
    expect(await saved).toContain('"tint":"#1f3fae"');
    await expect(cell(page, "tint")).toContainText("#1f3fae");

    // A decimal comma and a semicolon, as some type it: one spelling kept.
    saved = savedValues(page);
    await cell(page, "spot").click();
    await page.keyboard.type("48,8566; 2,3522");
    await page.keyboard.press("Enter");
    expect(await saved).toContain('"spot":"48.8566,2.3522"');
    await expect(cell(page, "spot")).toContainText("48.8566, 2.3522");
    // A place off the globe is none.
    await cell(page, "spot").click();
    await page.keyboard.type("95, 2");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Invalid value for Spot")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await accessibilityViolations(page)).toEqual([]);

    // A map has nothing to ask: it reads the place field, and leaves out
    // the row that has none.
    await page.getByRole("button", { name: "New view" }).click();
    await page.getByRole("menuitem", { name: "Map" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expect(page.getByTitle("Paris", { exact: true })).toBeVisible();
    await expect(page.getByText("1 point", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Place")).toHaveValue("spot");
    await expect(page.getByLabel("Latitude")).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);

    expect(blocked).toEqual([]);
  });
});

// Ctrl Z and Ctrl Y take back a list's last choice and a link while their
// panel is still open, as the toolbar's Undo and Redo do.
test("a choice and a link are undone from the keyboard, the panel open", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Undo User");
  const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  await addField(page, tableId, {
    name: "tags",
    label: "Tags",
    fieldType: "multi_select",
    options: ["Red", "Green"],
  });
  const relation = await page.request.post("/trpc/catalog.addRelation", {
    data: {
      tableId,
      name: "related",
      label: "Related",
      kind: "many_to_many",
      targetTableId: tableId,
    },
  });
  expect(relation.ok(), await relation.text()).toBe(true);
  for (const name of ["Ada", "Bob"]) {
    const inserted = await page.request.post("/trpc/rows.insert", {
      data: { tableId, values: { name } },
    });
    expect(inserted.ok(), await inserted.text()).toBe(true);
  }
  await page.reload();

  await cell(page, "tags").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  let saved = savedValues(page);
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"tags":["Red"]');
  await page.keyboard.press("ArrowDown");
  saved = savedValues(page);
  await page.keyboard.press("Enter");
  expect(await saved).toContain('"tags":["Red","Green"]');
  saved = savedValues(page);
  await page.keyboard.press("Control+z");
  expect(await saved).toContain('"tags":["Red"]');
  await expect(page.getByRole("option", { name: "Green" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  saved = savedValues(page);
  await page.keyboard.press("Control+y");
  expect(await saved).toContain('"tags":["Red","Green"]');
  await page.keyboard.press("Escape");
  await expect(cell(page, "tags")).toContainText("Green");

  const links = () =>
    page
      .waitForRequest((request) => request.url().includes("rows.setLinks"))
      .then((request) => request.postData() ?? "");
  await cell(page, "related").click();
  await page.keyboard.press("Enter");
  const bob = page.getByRole("option", { name: "Bob" });
  let sent = links();
  await bob.click();
  expect(await sent).toMatch(/"targetIds":\["[^"]+"\]/);
  sent = links();
  await page.keyboard.press("Control+z");
  expect(await sent).toContain('"targetIds":[]');
  await expect(bob).toHaveAttribute("aria-selected", "false");
  sent = links();
  await page.keyboard.press("Control+y");
  expect(await sent).toMatch(/"targetIds":\["[^"]+"\]/);
  await expect(bob).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(cell(page, "related")).toContainText("Bob");
  expect(blocked).toEqual([]);
});

// A map over the tiles of the server an administrator names (ADR 0068):
// moved by its buttons, by dragging, and by the wheel, brought back to
// its rows by one button; and a pin still opens its row. It makes an
// account, so it takes a client address of its own: sign-ups are counted
// per address, and the other journeys share theirs.
test.describe("a map over tiles", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.90" } });

  test("moves by its buttons, by dragging, and by the wheel", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    const { email } = await signUpWithTable(page, "Map User");
    const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    // Naming a tile server is an administrator's setting, and the journeys'
    // first account alone is one: this one is made one in the database.
    const control = new pg.Client({ connectionString: controlUrl });
    await control.connect();
    try {
      await control.query("update users set is_admin = true where email = $1", [
        email,
      ]);
    } finally {
      await control.end();
    }
    await send(page, "admin.stepUp", { password: "correct-horse-battery" });
    await send(page, "admin.updateSettings", {
      mapTileUrl: "https://tiles.example.org/{z}/{x}/{y}.png",
      mapTileCredit: "Example tiles",
    });
    try {
      await addField(page, tableId, {
        name: "latitude",
        label: "Latitude",
        fieldType: "number",
      });
      await addField(page, tableId, {
        name: "longitude",
        label: "Longitude",
        fieldType: "number",
      });
      await send(page, "rows.insertMany", {
        tableId,
        rows: [
          { name: "Paris", latitude: "48.85", longitude: "2.35" },
          { name: "Tokyo", latitude: "35.68", longitude: "139.69" },
        ],
      });
      // The page's policy names the tile server once it is read again.
      await page.reload();
      await page.getByRole("button", { name: "New view" }).click();
      await page.getByRole("menuitem", { name: "Map" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create", exact: true })
        .click();

      const controls = page.getByRole("group", { name: "Move the map" });
      const reset = controls.getByRole("button", { name: "Reset the map" });
      const paris = page.getByTitle("Paris", { exact: true });
      await expect(controls).toBeVisible();
      await expect(paris).toBeVisible();
      await expect(reset).toBeDisabled();
      const place = async () => (await paris.boundingBox())?.x ?? 0;
      const fitted = await place();

      // By its buttons, which a keyboard reaches: east, and the pin goes west.
      await controls.getByRole("button", { name: "Move east" }).focus();
      await page.keyboard.press("Enter");
      await expect(reset).toBeEnabled();
      expect(await place()).toBeLessThan(fitted);
      await reset.click();
      await expect(reset).toBeDisabled();
      expect(await place()).toBeCloseTo(fitted, 0);

      // By dragging: the map follows the pointer.
      const sheet = page.locator(
        "div:has(> [role='group'][aria-label='Move the map'])",
      );
      const box = (await sheet.boundingBox()) ?? {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x - 60, middle.y, { steps: 4 });
      await page.mouse.up();
      await expect(reset).toBeEnabled();
      expect(await place()).toBeLessThan(fitted);
      await reset.click();

      // By the wheel: closer, and the page itself does not scroll.
      await page.mouse.move(middle.x, middle.y);
      await page.mouse.wheel(0, -120);
      await expect(reset).toBeEnabled();
      await reset.click();
      await expect(reset).toBeDisabled();

      // A press that does not drag is still a click: the pin opens its row.
      await paris.click();
      await expect(
        page.getByRole("complementary", { name: "Row details" }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
    } finally {
      await send(page, "admin.updateSettings", {
        mapTileUrl: null,
        mapTileCredit: null,
      });
    }
    expect(blocked).toEqual([]);
  });
});
