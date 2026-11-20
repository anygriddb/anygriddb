import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  accessibilityViolations,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

/** Sends a change to the API with the page's session, as the app does. */
async function send(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.post(`/trpc/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

const tableIdOf = (page: Page) =>
  /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";

/** A view of the open table, made from the tabs. */
async function newView(page: Page, type: string): Promise<void> {
  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("menuitem", { name: type }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
}

/** The day of this month, as the API takes a date. */
function dayOfThisMonth(day: number): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Four rows, three to do and one in progress, each due this month; the
 * first has a site, which its card shows as a link.
 */
async function fourRows(page: Page): Promise<void> {
  const tableId = tableIdOf(page);
  await send(page, "catalog.addColumn", {
    tableId,
    name: "due",
    label: "Due",
    fieldType: "date",
  });
  await send(page, "catalog.addColumn", {
    tableId,
    name: "site",
    label: "Site",
    fieldType: "url",
  });
  await send(page, "rows.insertMany", {
    tableId,
    rows: [
      {
        name: "Alpha",
        status: "To do",
        due: dayOfThisMonth(10),
        site: "https://example.org/alpha",
      },
      { name: "Bravo", status: "To do", due: dayOfThisMonth(11) },
      { name: "Charlie", status: "To do", due: dayOfThisMonth(12) },
      { name: "Delta", status: "In progress", due: dayOfThisMonth(13) },
    ],
  });
  await expect(page.getByRole("gridcell", { name: "Delta" })).toBeVisible();
}

/** Presses on one element, carries it over another, and lets go there. */
async function carry(
  page: Page,
  from: Locator,
  onto: Locator,
  at: { x: number; y: number },
): Promise<void> {
  const start = await from.boundingBox();
  const end = await onto.boundingBox();
  if (!start || !end) throw new Error("nothing to carry, or nowhere");
  await page.mouse.move(start.x + 12, start.y + 8);
  await page.mouse.down();
  // A drag starts once the pointer has moved, and a target takes it once
  // it has moved over it.
  await page.mouse.move(start.x + 40, start.y + 24, { steps: 4 });
  await page.mouse.move(end.x + at.x, end.y + at.y, { steps: 12 });
  await page.mouse.up();
}

// The views that draw rows as cards: what a person does to a card with the
// keyboard and with the pointer, and what stays after a reload. It makes
// an account, so it takes a client address of its own.
test.describe("a kanban, a gallery, and a calendar", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.95" } });

  test("open a card's row and move the card, from the keyboard and by the pointer", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Card Mover");
    await fourRows(page);
    const panel = page.getByRole("complementary", { name: "Row details" });
    // What a screen reader is told when a drag starts.
    const dragStarted = page.getByText(/Started dragging/);

    await newView(page, "Kanban");
    const stack = (name: string) =>
      page.getByRole("region", { name, exact: true });
    const card = (name: string) =>
      page.getByRole("button", { name: new RegExp(`^${name}`) });
    const handle = (name: string) =>
      page.getByRole("button", { name: `Move ${name}`, exact: true });
    /** The cards of a stack, in its order, by their handles. */
    const cardsOf = (name: string) =>
      stack(name)
        .getByRole("button", { name: /^Move / })
        .evaluateAll((handles) =>
          handles.map((item) =>
            (item.getAttribute("aria-label") ?? "").replace("Move ", ""),
          ),
        );
    await expect
      .poll(() => cardsOf("To do"))
      .toEqual(["Alpha", "Bravo", "Charlie"]);
    // A card is opened by its name, and an address among its fields stays
    // a link beside it: neither holds the other.
    await expect(card("Alpha")).toHaveAccessibleName("Alpha");
    await expect(
      stack("To do").getByRole("link", { name: "https://example.org/alpha" }),
    ).toHaveAttribute("href", "https://example.org/alpha");
    expect(await accessibilityViolations(page)).toEqual([]);

    // Enter on a card opens its row and nothing else: no drag starts under
    // it. The row's panel takes the keyboard, and Escape gives it back to
    // the card.
    for (const key of ["Enter", " "]) {
      await card("Bravo").focus();
      await page.keyboard.press(key);
      await expect(panel.getByRole("heading", { name: "Bravo" })).toBeVisible();
      await expect(panel).toBeFocused();
      await expect(panel).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(card("Bravo")).toBeFocused();
    }
    // Nothing was said of a drag: what is said stays a few seconds.
    await expect(dragStarted).toHaveCount(0);

    // A card is picked up by its handle, the stop after the card itself,
    // carried to a stack with Tab, and dropped there with Enter. The
    // stack keeps the keyboard.
    await page.keyboard.press("Tab");
    await expect(handle("Bravo")).toBeFocused();
    await expect(handle("Bravo")).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(dragStarted).toHaveCount(1);
    await expect(async () => {
      await page.keyboard.press("Tab");
      await expect(stack("In progress")).toBeFocused({ timeout: 500 });
    }).toPass();
    await page.keyboard.press("Enter");
    await expect.poll(() => cardsOf("In progress")).toEqual(["Bravo", "Delta"]);
    await expect.poll(() => cardsOf("To do")).toEqual(["Alpha", "Charlie"]);
    await expect(stack("In progress")).toBeFocused();

    // Carried onto another card, it lands beside it: after the one below.
    await handle("Alpha").focus();
    await page.keyboard.press("Enter");
    const besideCharlie = stack("To do").getByRole("group", {
      name: "Charlie",
      exact: true,
    });
    await expect(async () => {
      await page.keyboard.press("Tab");
      await expect(besideCharlie).toBeFocused({ timeout: 500 });
    }).toPass();
    await page.keyboard.press("Enter");
    await expect.poll(() => cardsOf("To do")).toEqual(["Charlie", "Alpha"]);

    // Escape puts a card back down where it was. Picked up, a card's own
    // stack is the first place offered.
    await handle("Charlie").focus();
    await page.keyboard.press("Enter");
    await expect(stack("To do")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(handle("Charlie")).toBeFocused();
    await expect.poll(() => cardsOf("To do")).toEqual(["Charlie", "Alpha"]);
    expect(await accessibilityViolations(page)).toEqual([]);

    // By the pointer: onto the upper half of a card of another stack, the
    // card goes into that stack, above it. The order is the table's.
    await carry(page, card("Charlie"), card("Delta"), { x: 40, y: 6 });
    await expect
      .poll(() => cardsOf("In progress"))
      .toEqual(["Bravo", "Charlie", "Delta"]);
    await page.reload();
    await expect
      .poll(() => cardsOf("In progress"))
      .toEqual(["Bravo", "Charlie", "Delta"]);
    await expect.poll(() => cardsOf("To do")).toEqual(["Alpha"]);

    // A gallery's card opens its row by a click in its middle, and from
    // the keyboard, and stays where it is.
    await newView(page, "Gallery");
    await card("Alpha").click();
    await expect(panel.getByRole("heading", { name: "Alpha" })).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
    await card("Delta").focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("heading", { name: "Delta" })).toBeVisible();
    await expect(panel).toBeFocused();
    // A person being mentioned is chosen or not: Escape closes that list
    // and keeps the comment being written, and the row.
    const comment = panel.getByRole("textbox", { name: "Comment" });
    await comment.click();
    await page.keyboard.type("Seen with @Card");
    await expect(
      page.getByRole("listbox", { name: "People to mention" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("listbox", { name: "People to mention" }),
    ).toHaveCount(0);
    await expect(comment).toHaveValue("Seen with @Card");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(card("Delta")).toBeFocused();
    await expect(dragStarted).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);

    // A calendar names each day, and what it holds that day. An event is
    // carried to another day, and a day asked twice takes a new row.
    await newView(page, "Calendar");
    const month = new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
    }).format(new Date());
    const day = (number: number) =>
      page.getByRole("group", {
        name: new RegExp(`\\b${String(number)} ${month}$`),
      });
    await expect(day(10).getByRole("button", { name: "Alpha" })).toBeVisible();
    await carry(page, day(10).getByRole("button", { name: "Alpha" }), day(20), {
      x: 30,
      y: 60,
    });
    await expect(day(20).getByRole("button", { name: "Alpha" })).toBeVisible();
    await expect(day(10).getByRole("button", { name: "Alpha" })).toHaveCount(0);
    await day(20).getByRole("button", { name: "Alpha" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeFocused();
    const [year, monthNumber] = dayOfThisMonth(20).split("-");
    await expect(
      panel.getByText(`20/${monthNumber ?? ""}/${year ?? ""}`, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(day(20).getByRole("button", { name: "Alpha" })).toBeFocused();
    await day(22).dblclick({ position: { x: 30, y: 60 } });
    await expect(
      panel.getByRole("heading", { name: "Untitled" }),
    ).toBeVisible();
    await expect(day(22).getByRole("button")).toHaveCount(1);
    // A row added from the bar takes today, so that the calendar shows
    // the row it just made. The page's clock is set to a day that holds
    // no row of this journey.
    await page.clock.setFixedTime(new Date(`${dayOfThisMonth(25)}T10:00:00`));
    await page.getByRole("button", { name: "Add a row and open it" }).click();
    await expect(day(25).getByRole("button")).toHaveCount(1);
    await expect(
      panel.getByText(`25/${monthNumber ?? ""}/${year ?? ""}`, { exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    expect(blocked).toEqual([]);
  });
});

// A dashboard's widgets are moved the same way while it is arranged: by
// a handle, onto another widget, whose place the one moved takes. One of
// them shows a view of a table. It makes an account, so it takes a client
// address of its own.
test.describe("a dashboard", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.96" } });

  test("moves a widget from the keyboard, and shows a table's only view", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Board Mover");
    await send(page, "catalog.addColumn", {
      tableId: tableIdOf(page),
      name: "amount",
      label: "Amount",
      fieldType: "number",
      config: { number: { style: "currency", currency: "EUR", precision: 2 } },
    });
    await send(page, "catalog.addColumn", {
      tableId: tableIdOf(page),
      name: "due",
      label: "Due",
      fieldType: "date",
    });
    await send(page, "rows.insertMany", {
      tableId: tableIdOf(page),
      rows: [
        { name: "Alpha", status: "To do", amount: "34.2", due: "2026-01-09" },
        { name: "Bravo", status: "Done", amount: "1200.5", due: "2026-03-31" },
      ],
    });
    // A second table, which has none of the first one's fields.
    const made = await page.request.post("/trpc/catalog.createTable", {
      data: {
        baseId: /\/b\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "",
        name: "Ledger",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      },
    });
    expect(made.ok(), await made.text()).toBe(true);
    await send(page, "rows.insertMany", {
      tableId: ((await made.json()) as { result: { data: { id: string } } })
        .result.data.id,
      rows: [{ title: "Opening" }],
    });
    await page.getByRole("link", { name: "Dashboards" }).click();
    await page.getByLabel("New dashboard").fill("Board");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    for (const title of ["First", "Second", "Third"]) {
      await page.getByRole("button", { name: "Add a widget" }).click();
      const added = page.getByRole("dialog", { name: "Add a widget" });
      await added.getByLabel("Title", { exact: true }).fill(title);
      await added.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
    const widget = (title: string) =>
      page.getByRole("article", { name: title, exact: true });
    /** The widgets as they are read: by row, then by column. */
    const board = () =>
      page.getByRole("article").evaluateAll((articles) =>
        articles
          .map((article) => ({
            title: article.getAttribute("aria-label") ?? "",
            box: article.getBoundingClientRect(),
          }))
          .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
          .map((item) => item.title),
      );
    await expect.poll(board).toEqual(["First", "Second", "Third"]);

    // A widget's menu opens from the keyboard, and nothing is picked up.
    await page.getByRole("button", { name: "Actions for First" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Actions for First" }),
    ).toBeFocused();
    await expect(page.getByText(/Started dragging/)).toHaveCount(0);

    // Picked up by its handle, the first widget is offered the others in
    // turn, and takes the place of the one it is dropped on.
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("button", { name: "Move First" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(widget("Second")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(widget("Third")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(board).toEqual(["Second", "Third", "First"]);
    await expect(widget("Third")).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);

    // A widget that shows a view takes the one its list shows: a table's
    // only view, with nothing to choose.
    await page.getByRole("button", { name: "Add a widget" }).click();
    const added = page.getByRole("dialog", { name: "Add a widget" });
    await added.getByLabel("Title", { exact: true }).fill("Every sample");
    await added.getByLabel("Type").selectOption({ label: "Embedded view" });
    await expect(added.getByLabel("View", { exact: true })).toHaveValue(/.+/);
    await added.getByRole("button", { name: "Add", exact: true }).click();
    await expect(added).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Every sample" }),
    ).toBeVisible();
    // It shows the view's rows, each with the fields the view shows, and
    // says how many it holds.
    const sample = page.getByRole("table", { name: "Every sample" });
    await expect(
      sample.getByRole("columnheader").filter({ hasText: /^(Name|Status)$/ }),
    ).toHaveCount(2);
    await expect(sample.getByRole("row")).toHaveCount(3);
    await expect(
      sample.getByRole("row", { name: /Bravo/ }).getByText("Done"),
    ).toBeVisible();
    await expect(widget("Every sample").getByText("2 rows")).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    // A figure and a chart are written as the field they measure is: a
    // sum of euros is euros, where it read as a bare number.
    await page.getByRole("button", { name: "Add a widget" }).click();
    const figure = page.getByRole("dialog", { name: "Add a widget" });
    await figure.getByLabel("Title", { exact: true }).fill("Billed");
    // A sum reads a number: the list of fields holds the table's one,
    // and what it shows is what is measured.
    await figure
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Sum" });
    await expect(figure.getByLabel("Measured field")).toHaveValue("amount");
    await figure.getByRole("button", { name: "Add", exact: true }).click();
    await expect(figure).toBeHidden();
    await expect(widget("Billed").getByText("€1,234.70")).toBeVisible();
    // A figure reads the last value of a field: the amount of the row
    // due last, written as the field writes it.
    await page.getByRole("button", { name: "Add a widget" }).click();
    const latest = page.getByRole("dialog", { name: "Add a widget" });
    await latest.getByLabel("Title", { exact: true }).fill("Last billed");
    await latest
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Last value" });
    await latest.getByLabel("Measured field").selectOption({ label: "Amount" });
    // The table's one date puts its rows in order, as the list shows.
    await expect(latest.getByLabel("Rows ordered by")).toHaveValue("due");
    expect(await accessibilityViolations(page)).toEqual([]);
    await latest.getByRole("button", { name: "Add", exact: true }).click();
    await expect(latest).toBeHidden();
    await expect(widget("Last billed").getByText("€1,200.50")).toBeVisible();
    // A widget's lists follow its table. A figure started on one table,
    // then given another, measures the field the other's list shows: the
    // form kept the first table's field, which the second does not have.
    await page.getByRole("button", { name: "Add a widget" }).click();
    const moved = page.getByRole("dialog", { name: "Add a widget" });
    await moved.getByLabel("Title", { exact: true }).fill("Entries named");
    await moved
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Filled" });
    await moved.getByLabel("Measured field").selectOption({ label: "Amount" });
    await moved.getByLabel("Table").selectOption({ label: "Ledger" });
    await expect(moved.getByLabel("Measured field")).toHaveValue("title");
    // A sum has nothing to read there, and the form says so.
    await moved
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Sum" });
    await expect(
      moved.getByText("This table has no field this measure can read."),
    ).toBeVisible();
    await expect(
      moved.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    expect(await accessibilityViolations(page)).toEqual([]);
    await moved
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Filled" });
    await moved.getByRole("button", { name: "Add", exact: true }).click();
    await expect(moved).toBeHidden();
    await expect(
      widget("Entries named").getByText("1", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add a widget" }).click();
    const chart = page.getByRole("dialog", { name: "Add a widget" });
    await chart.getByLabel("Title", { exact: true }).fill("Billed by status");
    await chart.getByLabel("Type").selectOption({ label: "Chart" });
    await chart
      .getByLabel("Measure", { exact: true })
      .selectOption({ label: "Sum" });
    await chart.getByLabel("Measured field").selectOption({ label: "Amount" });
    await chart.getByLabel("Group by").selectOption({ label: "Status" });
    await chart.getByRole("button", { name: "Add", exact: true }).click();
    await expect(chart).toBeHidden();
    await widget("Billed by status")
      .getByRole("button", { name: "Show the table of values" })
      .click();
    const values = widget("Billed by status").getByRole("table");
    await expect(values.getByRole("cell", { name: "€1,200.50" })).toBeVisible();
    // The categories stand in their field's order, a list's options:
    // "To do" before "Done".
    await expect(values.getByRole("rowheader")).toHaveText(["To do", "Done"]);
    expect(await accessibilityViolations(page)).toEqual([]);
    // By value, the largest first, and the first alone: the rest is
    // counted under the chart.
    await page
      .getByRole("button", { name: "Actions for Billed by status" })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const ordered = page.getByRole("dialog", { name: "Edit the widget" });
    await ordered
      .getByLabel("Order", { exact: true })
      .selectOption({ label: "Largest value first" });
    await ordered.getByLabel("Categories shown").fill("1");
    expect(await accessibilityViolations(page)).toEqual([]);
    await ordered.getByRole("button", { name: "Save", exact: true }).click();
    await expect(ordered).toBeHidden();
    await expect(
      widget("Billed by status").getByText("1 more category is not shown."),
    ).toBeVisible();
    await expect(values.getByRole("rowheader")).toHaveText(["Done"]);
    // Dates are grouped by their month, each named by it: the days of
    // January together, and those of March.
    await page.getByRole("button", { name: "Add a widget" }).click();
    const monthly = page.getByRole("dialog", { name: "Add a widget" });
    await monthly.getByLabel("Title", { exact: true }).fill("Due by month");
    await monthly.getByLabel("Type").selectOption({ label: "Chart" });
    await monthly.getByLabel("Group by").selectOption({ label: "Due" });
    await monthly
      .getByLabel("Dates grouped by")
      .selectOption({ label: "Month" });
    expect(await accessibilityViolations(page)).toEqual([]);
    await monthly.getByRole("button", { name: "Add", exact: true }).click();
    await expect(monthly).toBeHidden();
    await widget("Due by month")
      .getByRole("button", { name: "Show the table of values" })
      .click();
    await expect(
      widget("Due by month").getByRole("table").getByRole("rowheader"),
    ).toHaveText(["Jan 2026", "Mar 2026"]);
    // On a phone the widgets stand one under another, each as wide as
    // the page: twelve columns have no room there.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const title of ["First", "Every sample"]) {
      await expect
        .poll(async () => (await widget(title).boundingBox())?.width ?? 0)
        .toBeGreaterThan(300);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 720 });
    // A row's name opens that row in its table.
    await sample.getByRole("link", { name: "Bravo" }).click();
    await expect(
      page
        .getByRole("complementary", { name: "Row details" })
        .getByRole("heading", { name: "Bravo" }),
    ).toBeVisible();

    expect(blocked).toEqual([]);
  });
});

// A timeline is wider than the page at the scale of a year: it opens on
// today, where what is under way shows. A bar too short for its row's
// name leaves it to the head of its line. It makes an account, so it
// takes a client address of its own.
test.describe("a timeline", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.97" } });

  test("opens on today at every scale, and leaves a short bar bare", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Timeline Reader");
    const tableId = tableIdOf(page);
    for (const name of ["start", "due"]) {
      await send(page, "catalog.addColumn", {
        tableId,
        name,
        fieldType: "date",
      });
    }
    await send(page, "rows.insertMany", {
      tableId,
      rows: [
        { name: "Harvest", start: "2026-11-16", due: "2026-11-27" },
        { name: "Tasting", start: "2026-11-19", due: "2026-11-19" },
      ],
    });
    // A day of the autumn: at the scale of a year it lies past the page's
    // right edge, whatever the day the journey runs.
    await page.clock.setFixedTime(new Date("2026-11-19T10:00:00"));
    await page.reload();
    await newView(page, "Timeline");
    await page
      .getByRole("combobox", { name: "End", exact: true })
      .selectOption({ label: "due" });
    // A row is named at the head of its line, then by its bar.
    const bar = (name: string) =>
      page.getByRole("button", { name, exact: true }).nth(1);
    const scale = page.getByRole("combobox", { name: "Scale" });

    // A quarter: the fortnight's bar is named, the day's is too short.
    await expect(bar("Harvest")).toBeInViewport();
    await expect(bar("Harvest")).toHaveText("Harvest");
    await expect(bar("Tasting")).toBeInViewport();
    const nameWidth = async (name: string) =>
      (await bar(name).locator("span").boundingBox())?.width ?? 0;
    expect(await nameWidth("Tasting")).toBeLessThanOrEqual(1);
    await expect(bar("Tasting")).toHaveAccessibleName("Tasting");

    // A year, four pixels a day: November is past the page's width.
    await scale.selectOption("month");
    await expect(page.getByText("2026", { exact: true })).toBeVisible();
    await expect(bar("Harvest")).toBeInViewport();
    expect(await nameWidth("Harvest")).toBeLessThanOrEqual(1);

    // A month, forty pixels a day: both bars are named.
    await scale.selectOption("day");
    await expect(bar("Tasting")).toBeInViewport();
    await expect(bar("Harvest")).toHaveText("Harvest");
    expect(await nameWidth("Tasting")).toBeLessThanOrEqual(1);

    // Another period starts at its first day; back to this one, on today.
    await page.getByRole("button", { name: "Next period" }).click();
    await expect(page.getByText("December 2026")).toBeVisible();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(bar("Tasting")).toBeInViewport();

    // A row added from the bar starts today: the timeline draws the bar
    // of the row it just made, named by its number while it has no name,
    // and the row's panel says the day.
    await page.getByRole("button", { name: "Add a row and open it" }).click();
    await expect(bar("#3")).toBeInViewport();
    await expect(
      page
        .getByRole("complementary", { name: "Row details" })
        .getByText("19/11/2026", { exact: true }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    expect(blocked).toEqual([]);
  });
});
