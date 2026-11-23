import { expect, test, type Page } from "./journey";
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

const cells = (page: Page, column: string) =>
  page.locator(`[role="gridcell"][data-column="${column}"]`);

/** Picks an entry of a field's menu, in the grid's header. */
async function fieldMenu(page: Page, field: string, entry: string) {
  await page.getByRole("button", { name: `${field} field menu` }).click();
  await page.getByRole("menuitem", { name: entry, exact: true }).click();
}

/** A table with an amount, and three rows not in the alphabet's order. */
async function threeRows(page: Page): Promise<void> {
  const tableId = tableIdOf(page);
  await send(page, "catalog.addColumn", {
    tableId,
    name: "amount",
    label: "Amount",
    fieldType: "number",
  });
  await send(page, "rows.insertMany", {
    tableId,
    rows: [
      { name: "Bravo", status: "To do", amount: "20" },
      { name: "Alpha", status: "Done", amount: "10" },
      { name: "Charlie", status: "To do", amount: "30" },
    ],
  });
  await expect(cells(page, "name")).toHaveText(["Bravo", "Alpha", "Charlie"]);
}

/** The id of the first row a search of the open table finds. */
async function firstRowId(page: Page, search: string): Promise<string> {
  const input = { tableId: tableIdOf(page), limit: 1, search };
  const response = await page.request.get(
    `/trpc/rows.read?input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as {
    result: { data: { rows: Array<{ id: string }> } };
  };
  return body.result.data.rows[0]?.id ?? "";
}

// What a field's menu does to the view and to the table: each entry, as a
// person picks it, and what stays after a reload. It makes an account, so
// it takes a client address of its own.
test.describe("a field's menu", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.85" } });

  test("sorts, groups, filters, hides, and freezes the view, and adds, copies, and deletes fields", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Mona Menu");

    // An empty table says where to start, and offers to bring a file.
    await expect(page.getByText("No rows yet.")).toBeVisible();
    await page.getByRole("button", { name: "Import a file" }).click();
    const importing = page.getByRole("dialog", { name: "Import rows" });
    await expect(importing).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(importing).toBeHidden();

    await threeRows(page);
    const names = cells(page, "name");
    await expect(page.getByText("No rows yet.")).toHaveCount(0);

    // A search that finds nothing says so, rather than how to start.
    await page.getByLabel("Search this view").fill("zulu");
    await expect(
      page.getByText("No row matches this view's filters or search."),
    ).toBeVisible();
    await page.getByLabel("Search this view").fill("");
    await expect(names).toHaveCount(3);

    // Sorted from the menu: the order holds after a reload, a second
    // choice replaces the first, and rows no longer move by hand.
    await fieldMenu(page, "Name", "Sort Z → A");
    await expect(names).toHaveText(["Charlie", "Bravo", "Alpha"]);
    const sorted = page.getByRole("button", { name: "Sorted by 1 field" });
    await expect(sorted).toBeVisible();
    await names.first().click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Copy", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Insert a row above" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(names).toHaveText(["Charlie", "Bravo", "Alpha"]);
    await fieldMenu(page, "Name", "Sort A → Z");
    await expect(names).toHaveText(["Alpha", "Bravo", "Charlie"]);
    await sorted.click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog").press("Escape");
    await expect(names).toHaveText(["Bravo", "Alpha", "Charlie"]);

    // Grouped from the menu: a header a value, with its count; all folded
    // and opened again from a header.
    await fieldMenu(page, "Status", "Group by this field");
    const grid = page.getByRole("grid");
    const group = (label: string) =>
      grid
        .locator('[role="row"]')
        .filter({ has: page.locator("button[aria-expanded]") })
        .filter({ hasText: label });
    await expect(group("To do")).toContainText("2");
    await expect(group("Done")).toContainText("1");
    await group("To do").hover();
    await group("To do").getByRole("button", { name: "Collapse all" }).click();
    await expect(names).toHaveCount(0);
    await group("To do").hover();
    await group("To do").getByRole("button", { name: "Expand all" }).click();
    await expect(names).toHaveCount(3);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Grouped by 1 field" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog").press("Escape");
    await expect(group("To do")).toHaveCount(0);

    // Hidden from the menu, and shown again from the toolbar.
    const header = (label: string) =>
      page.getByRole("columnheader", { name: new RegExp(`^${label}`) });
    await fieldMenu(page, "Notes", "Hide");
    await expect(header("Notes")).toHaveCount(0);
    await page.getByRole("button", { name: "1 hidden field" }).click();
    await page.getByRole("button", { name: "Show all" }).click();
    await page.keyboard.press("Escape");
    await expect(header("Notes")).toBeVisible();

    // Frozen up to a field, which then offers to free them all.
    await expect(header("Notes")).not.toHaveCSS("position", "sticky");
    await fieldMenu(page, "Notes", "Freeze up to here");
    await expect(header("Notes")).toHaveCSS("position", "sticky");
    await fieldMenu(page, "Notes", "Unfreeze columns");
    await expect(header("Notes")).not.toHaveCSS("position", "sticky");
    await expect(header("Name")).not.toHaveCSS("position", "sticky");

    // Filtered from the menu: the condition opens ready to fill. A row
    // added while the view asks for one value takes it, and stays in view.
    await fieldMenu(page, "Name", "Filter by this field");
    await page.getByLabel("Operator").selectOption({ label: "is" });
    await page.getByLabel("Value").fill("Alpha");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(names).toHaveText(["Alpha"]);
    await expect(page.getByRole("button", { name: "1 filter" })).toBeVisible();
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    await expect(names).toHaveText(["Alpha", "Alpha"]);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(names).toHaveCount(4);

    // A condition with nothing typed yet asks nothing: every row shows,
    // and a row is added as before. A number took the empty value of
    // its condition, and the row was refused whole.
    await fieldMenu(page, "Amount", "Filter by this field");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.getByRole("button", { name: "1 filter" })).toBeVisible();
    await expect(names).toHaveCount(4);
    await page.getByRole("button", { name: "Add a row", exact: true }).click();
    await expect(names).toHaveCount(5);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(names).toHaveCount(5);

    // A field added beside another lands there.
    await fieldMenu(page, "Name", "Insert right");
    const dialog = page.getByRole("dialog", { name: "New field" });
    await dialog.getByLabel("Field name").fill("Extra");
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog).toBeHidden();
    await expect(header("Extra")).toHaveAttribute("aria-colindex", "3");

    // A copy of a field comes with its values.
    await fieldMenu(page, "Amount", "Duplicate field");
    await expect(header("Amount \\(copy\\)")).toBeVisible();
    await expect(cells(page, "amount_copy")).toHaveText([
      "20",
      "10",
      "30",
      "",
      "",
    ]);

    // The primary field names the row and comes first; another takes its
    // place, and gives it back.
    await fieldMenu(page, "Extra", "Set as primary field");
    await expect(header("Extra ?, Primary field")).toHaveAttribute(
      "aria-colindex",
      "2",
    );
    await fieldMenu(page, "Name", "Set as primary field");
    await expect(header("Name ?, Primary field")).toHaveAttribute(
      "aria-colindex",
      "2",
    );

    // Deleted, a field goes to the trash, and the page says so.
    await fieldMenu(page, "Amount (copy)", "Delete field");
    const deleting = page.getByRole("dialog", {
      name: "Delete the field “Amount (copy)”?",
    });
    await expect(deleting).toContainText("go");
    expect(await accessibilityViolations(page)).toEqual([]);
    await deleting.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Field moved to the trash")).toBeVisible();
    await expect(header("Amount \\(copy\\)")).toHaveCount(0);
    await page.reload();
    await expect(header("Extra")).toBeVisible();
    await expect(header("Amount \\(copy\\)")).toHaveCount(0);

    // A menu offers what its field can do: files sort and filter a view,
    // and make no group. The entry was there, and the rows could no
    // longer be read once it was taken.
    await send(page, "catalog.addColumn", {
      tableId: tableIdOf(page),
      name: "files",
      label: "Files",
      fieldType: "attachment",
    });
    await page.reload();
    const entry = (name: string) =>
      page.getByRole("menuitem", { name, exact: true });
    await page.getByRole("button", { name: "Files field menu" }).click();
    await expect(entry("Sort A → Z")).toBeVisible();
    await expect(entry("Filter by this field")).toBeVisible();
    await expect(entry("Group by this field")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Status field menu" }).click();
    await expect(entry("Group by this field")).toBeVisible();
    await page.keyboard.press("Escape");
    // The toolbar's own list of groups leaves files out as well.
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page.getByRole("button", { name: "Add a level" }).click();
    const levels = page.getByRole("dialog").getByLabel("Field");
    await expect(levels.locator("option", { hasText: "Status" })).toHaveCount(
      1,
    );
    await expect(levels.locator("option", { hasText: "Files" })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog").press("Escape");

    // Frozen columns leave the others room to scroll. Frozen up to its
    // last field, a table wider than its window kept every column in
    // place: the last ones, their menus and the column that adds a field
    // lay under the others, and nothing scrolled them into view.
    await page.setViewportSize({ width: 1024, height: 720 });
    await fieldMenu(page, "Files", "Freeze up to here");
    await expect(header("Name")).toHaveCSS("position", "sticky");
    await expect(header("Files")).not.toHaveCSS("position", "sticky");
    await page.getByRole("button", { name: "Add a field" }).click();
    const added = page.getByRole("dialog", { name: "New field" });
    await expect(added).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(added).toBeHidden();
    // What takes the keyboard among the columns that scroll is brought
    // clear of those that stay: it stood under them.
    const labels = ["Name", "Extra", "Notes", "Status", "Amount", "Files"];
    const places = await Promise.all(
      labels.map((label) =>
        header(label).evaluate((node) => getComputedStyle(node).position),
      ),
    );
    const firstToScroll =
      labels[places.findIndex((place) => place !== "sticky")];
    expect(firstToScroll).toBeDefined();
    await page
      .getByRole("grid")
      .evaluate((node) => node.scrollTo({ left: node.scrollWidth }));
    const control = page.getByRole("button", {
      name: `${firstToScroll ?? ""} field menu`,
    });
    await control.focus();
    await expect
      .poll(() =>
        control.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return top === node || node.contains(top);
        }),
      )
      .toBe(true);
    // The margin as it is drawn frees the columns, whatever the view froze.
    const kept = labels[places.lastIndexOf("sticky")] ?? "";
    await fieldMenu(page, kept, "Unfreeze columns");
    await expect(header("Name")).not.toHaveCSS("position", "sticky");
    await page.setViewportSize({ width: 1280, height: 720 });

    // Rows coloured by rules: the first rule a row matches tints its
    // margin.
    await page.getByRole("button", { name: "Colour", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit colour rules" }).click();
    const rules = page.getByRole("dialog", { name: "Colour rules" });
    await rules.getByRole("button", { name: "Add a colour rule" }).click();
    await rules.getByLabel("Operator").selectOption({ label: "is" });
    await rules.getByLabel("Value").fill("Alpha");
    await rules
      .getByRole("radiogroup", { name: "Colour of rule 1" })
      .getByRole("radio", { name: "Green" })
      .check();
    expect(await accessibilityViolations(page)).toEqual([]);
    await rules.getByRole("button", { name: "Save" }).click();
    await expect(rules).toBeHidden();
    await expect(page.locator('[role="rowheader"].row-tint-green')).toHaveCount(
      2,
    );

    expect(blocked).toEqual([]);
  });
});

// What happens to rows on a table's page, whichever view shows them: a
// reason asked for, a summary under a field, rows ticked, copied, deleted,
// brought back, and walked through in the row's panel. It makes an account,
// so it takes a client address of its own.
test.describe("a table's rows", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.86" } });

  test("ask for a reason, add up, go to the trash and come back, and open one after another", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Rowan Rows");
    await threeRows(page);
    const names = cells(page, "name");
    const amounts = cells(page, "amount");
    const grid = page.getByRole("grid");

    // A change to a value someone else changed meanwhile is refused. The
    // editor opens on "Charlie"; by the time its change is sent, the row
    // holds "Delta". The page says so and shows what the row holds; made
    // again on that, the change is taken.
    const charlieId = await firstRowId(page, "Charlie");
    await names.nth(2).click();
    await page.keyboard.press("F2");
    const nameEditor = page.getByRole("textbox", { name: "Name" });
    await expect(nameEditor).toHaveValue("Charlie");
    await send(page, "rows.updateMany", {
      tableId: tableIdOf(page),
      updates: [{ rowId: charlieId, values: { name: "Delta" } }],
    });
    await nameEditor.fill("Echo");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/^Someone changed this value/)).toBeVisible();
    await expect(names).toHaveText(["Bravo", "Alpha", "Delta"]);
    await names.nth(2).click();
    await page.keyboard.press("F2");
    await expect(nameEditor).toHaveValue("Delta");
    await nameEditor.fill("Charlie");
    await page.keyboard.press("Enter");
    await expect(names).toHaveText(["Bravo", "Alpha", "Charlie"]);

    // A summary under a field.
    await grid.getByRole("button", { name: "Summary of Amount" }).click();
    await page.getByRole("menuitem", { name: "Sum", exact: true }).click();
    const sum = grid.getByRole("button", { name: /^Sum(?!mary)/ });
    await expect(sum).toContainText("60");

    // The row's panel walks the rows one after another, in the view's
    // order.
    await names.first().click();
    await page.keyboard.press(" ");
    const panel = page.getByRole("complementary", { name: "Row details" });
    const title = (name: string) => panel.getByRole("heading", { name });
    await expect(title("Bravo")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Previous row" }),
    ).toBeDisabled();
    await panel.getByRole("button", { name: "Next row" }).click();
    await expect(title("Alpha")).toBeVisible();
    await panel.getByRole("button", { name: "Next row" }).click();
    await expect(title("Charlie")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Next row" }),
    ).toBeDisabled();
    await panel.getByRole("button", { name: "Previous row" }).click();
    await expect(title("Alpha")).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // Copied from its panel, a row lands under the one it copies, and the
    // summary counts it.
    await panel.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate row" }).click();
    await expect(names).toHaveText(["Bravo", "Alpha", "Alpha", "Charlie"]);
    await expect(sum).toContainText("70");

    // Deleted from its panel: the panel closes, and the notice brings the
    // row back.
    await panel.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(panel).toHaveCount(0);
    await expect(names).toHaveText(["Bravo", "Alpha", "Charlie"]);
    await expect(
      page.getByText("1 row deleted", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(names).toHaveText(["Bravo", "Alpha", "Alpha", "Charlie"]);

    // A row's link opens the table with the row's panel.
    const charlie = await firstRowId(page, "Charlie");
    await page.goto(`${new URL(page.url()).pathname}?row=${charlie}`);
    await expect(title("Charlie")).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);

    // Rows ticked in the margin are counted, copied, and deleted together.
    await page.getByRole("checkbox", { name: "Select row 1" }).check();
    await page.getByRole("checkbox", { name: "Select row 4" }).check();
    const ticked = page.getByText("2 rows selected");
    await expect(ticked).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(names).toHaveCount(6);
    await expect(ticked).toHaveCount(0);

    // The last change is undone, and done again, from the toolbar.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(names).toHaveCount(4);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(names).toHaveCount(6);

    // Deleted rows wait in the table's trash, and come back from it.
    await page.getByRole("checkbox", { name: "Select row 5" }).check();
    await page.getByRole("checkbox", { name: "Select row 6" }).check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByText("2 rows deleted", { exact: true }),
    ).toBeVisible();
    await expect(names).toHaveCount(4);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Row trash" }).click();
    const trash = page.getByRole("dialog", { name: "Row trash" });
    await expect(trash.getByRole("listitem")).toHaveCount(2);
    expect(await accessibilityViolations(page)).toEqual([]);
    await trash.getByRole("checkbox").first().check();
    await trash.getByRole("button", { name: "Restore" }).click();
    await expect(
      page.getByText("1 row restored", { exact: true }),
    ).toBeVisible();
    await expect(trash.getByRole("listitem")).toHaveCount(1);
    await trash
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" })
      .click();
    await expect(names).toHaveCount(5);

    // A field that asks why: without a reason nothing changes; with one,
    // the change is written, the summary follows, and the row's history
    // keeps the reason.
    await fieldMenu(page, "Amount", "Edit field");
    const editing = page.getByRole("dialog", { name: "Edit field" });
    await editing.getByLabel("Require a reason for every change").check();
    await editing.getByRole("button", { name: "Save" }).click();
    await expect(editing).toBeHidden();
    const reason = page.getByRole("dialog", { name: "Reason for the change" });
    await amounts.first().click();
    await page.keyboard.type("25");
    await page.keyboard.press("Enter");
    await expect(reason).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await reason.getByRole("button", { name: "Cancel" }).click();
    await expect(reason).toBeHidden();
    await expect(amounts.first()).toHaveText("20");
    await amounts.first().click();
    await page.keyboard.type("25");
    await page.keyboard.press("Enter");
    await reason
      .getByLabel("This field needs a reason, kept in the audit trail.")
      .fill("Recount");
    const saved = page.waitForResponse(
      (response) => response.url().includes("rows.updateMany") && response.ok(),
    );
    await reason.getByRole("button", { name: "Confirm" }).click();
    await saved;
    await expect(amounts.first()).toHaveText("25");
    await names.first().click();
    await page.keyboard.press(" ");
    await panel.getByRole("tab", { name: "History" }).click();
    await expect(panel.getByText("Reason: Recount")).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();

    // Where a field asks why, a row that comes back says why too: from
    // the notice of its delete, from the keyboard, and from the trash.
    const why = reason.getByLabel(/needs a reason/);
    const confirm = reason.getByRole("button", { name: "Confirm" });
    const deleteSecond = async (because: string) => {
      await names.nth(1).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete rows" }).click();
      await why.fill(because);
      await confirm.click();
      await expect(names).toHaveCount(4);
    };
    await deleteSecond("One too many");
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "1 row deleted" })
      .getByRole("button", { name: "Cancel" })
      .first()
      .click();
    await why.fill("Needed after all");
    await confirm.click();
    await expect(names).toHaveCount(5);

    // An undo left without its reason changes nothing, and can be asked
    // again.
    await deleteSecond("Twice now");
    await names.first().click();
    await page.keyboard.press("Control+z");
    await expect(reason).toBeVisible();
    await reason.getByRole("button", { name: "Cancel" }).click();
    await expect(reason).toBeHidden();
    await expect(names).toHaveCount(4);
    await page.keyboard.press("Control+z");
    await why.fill("Undone");
    await confirm.click();
    await expect(names).toHaveCount(5);

    await deleteSecond("Third time");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Row trash" }).click();
    await trash.getByRole("checkbox").first().check();
    await trash.getByRole("button", { name: "Restore" }).click();
    await why.fill("Back from the trash");
    await confirm.click();
    await expect(
      page.getByText("1 row restored", { exact: true }).last(),
    ).toBeVisible();
    await trash
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" })
      .click();
    await expect(names).toHaveCount(5);

    expect(blocked).toEqual([]);
  });
});

// The grid's own gestures: the keys that move the selection, a range
// copied, pasted, cleared, filled down, and dragged further, a row's menu,
// the rows' height, and a field moved by its header. It makes an account,
// so it takes a client address of its own.
test.describe("the grid", () => {
  test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.87" } });

  test("is walked by keys, copies and fills ranges, and moves its rows and fields", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Greta Grid");
    const tableId = tableIdOf(page);
    await send(page, "catalog.addColumn", {
      tableId,
      name: "amount",
      label: "Amount",
      fieldType: "number",
    });
    await send(page, "catalog.addColumn", {
      tableId,
      name: "done",
      label: "Done",
      fieldType: "boolean",
    });
    await send(page, "rows.insertMany", {
      tableId,
      rows: [
        { name: "One", notes: "n1", amount: "1" },
        { name: "Two", notes: "n2", amount: "2" },
        { name: "Three", notes: "n3", amount: "30" },
        { name: "Four", notes: "n4", amount: "40" },
      ],
    });
    const grid = page.getByRole("grid");
    const names = cells(page, "name");
    const notes = cells(page, "notes");
    const amounts = cells(page, "amount");
    await expect(names).toHaveText(["One", "Two", "Three", "Four"]);
    const selected = grid.locator('[role="gridcell"][aria-selected="true"]');
    const saved = () =>
      page.waitForResponse(
        (response) =>
          response.url().includes("rows.updateMany") && response.ok(),
      );

    // The keys that jump: to the ends of a column and of a row, a page
    // down, and back to the first cell.
    await names.first().click();
    await page.keyboard.press("Control+ArrowDown");
    await expect(selected).toHaveAccessibleName("Name: Four");
    await page.keyboard.press("End");
    await expect(selected).toHaveAttribute("data-column", "done");
    await page.keyboard.press("Control+Home");
    await expect(selected).toHaveAccessibleName("Name: One");
    await page.keyboard.press("PageDown");
    await expect(selected).toHaveAccessibleName("Name: Four");
    await page.keyboard.press("Control+ArrowUp");
    await page.keyboard.press("Control+ArrowRight");
    await expect(selected).toHaveAttribute("data-column", "done");

    // Enter ticks a checkbox where it stands; F2 opens a text, which
    // Escape leaves as it was.
    const ticked = saved();
    await page.keyboard.press("Enter");
    await ticked;
    await expect(selected).toHaveAccessibleName("Done: ✓");
    await page.keyboard.press("Home");
    await page.keyboard.press("F2");
    const editor = page.getByRole("textbox", { name: "Name" });
    await expect(editor).toHaveValue("One");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(names.first()).toHaveText("One");

    // Shift Enter opens the row.
    await page.keyboard.press("Shift+Enter");
    const panel = page.getByRole("complementary", { name: "Row details" });
    await expect(panel.getByRole("heading", { name: "One" })).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);

    // A range, extended with Shift: its cells are counted and added up.
    await amounts.first().click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(selected).toHaveCount(3);
    const statistics = page.getByRole("status", {
      name: "Selection statistics",
    });
    await expect(statistics).toHaveText(
      "Filled: 3 of 3 · Sum: 33 · Mean: 11 · Min: 1 · Max: 30",
    );
    expect(await accessibilityViolations(page)).toEqual([]);

    // Copied, the range is pasted from another cell down; past the last
    // row, what is pasted adds rows.
    await page.keyboard.press("Control+c");
    await expect(page.getByText("3 cells copied")).toBeVisible();
    await notes.nth(1).click();
    await expect(selected).toHaveCount(1);
    await page.keyboard.press("Control+v");
    await expect(notes).toHaveText(["n1", "1", "2", "30"]);
    // What was pasted is the selection, once it is saved.
    await expect(selected).toHaveCount(3);
    await notes.nth(3).click();
    await expect(selected).toHaveCount(1);
    await page.keyboard.press("Control+v");
    await expect(notes).toHaveText(["n1", "1", "2", "1", "2", "30"]);
    await expect(names).toHaveCount(6);
    await expect(selected).toHaveCount(3);

    // A text pasted on a number is left out, and said.
    await names.first().click();
    await page.keyboard.press("Control+c");
    await expect(page.getByText("1 cell copied")).toBeVisible();
    await amounts.first().click();
    await page.keyboard.press("Control+v");
    await expect(
      page.getByText("1 cell skipped: incompatible value or computed field"),
    ).toBeVisible();
    await expect(amounts.first()).toHaveText("1");

    // Delete empties the range, and Ctrl Z brings it back.
    await notes.nth(4).click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Delete");
    await expect(notes).toHaveText(["n1", "1", "2", "1", "", ""]);
    await page.keyboard.press("Control+z");
    await expect(notes).toHaveText(["n1", "1", "2", "1", "2", "30"]);

    // Ctrl D copies the range's first row down it.
    await notes.first().click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Control+d");
    await expect(notes).toHaveText(["n1", "n1", "n1", "1", "2", "30"]);

    // The range's corner, dragged down, carries its series on.
    const dragCornerTo = async (row: number) => {
      const corner = await grid.locator(".cursor-ns-resize").boundingBox();
      const last = await amounts.nth(row).boundingBox();
      if (!corner || !last) throw new Error("the range has no corner to drag");
      await page.mouse.move(
        corner.x + corner.width / 2,
        corner.y + corner.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
    };
    await amounts.first().click();
    await page.keyboard.press("Shift+ArrowDown");
    await dragCornerTo(3);
    await expect(amounts).toHaveText(["1", "2", "3", "4", "", ""]);
    // The range grows over what it filled, once that is saved.
    await expect(selected).toHaveCount(4);

    // A cell chosen while a fill is being saved stays chosen: the save,
    // held here until the cell is clicked, does not take the selection
    // back when it ends.
    let letThrough: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      letThrough = resolve;
    });
    const isUpdate = (url: URL) => url.pathname.includes("rows.updateMany");
    await page.route(isUpdate, async (route) => {
      await held;
      await route.continue();
    });
    await amounts.nth(2).click();
    await page.keyboard.press("Shift+ArrowDown");
    await dragCornerTo(5);
    await expect(amounts).toHaveText(["1", "2", "3", "4", "5", "6"]);
    await names.first().click();
    const written = saved();
    letThrough();
    await written;
    await page.unroute(isUpdate);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAccessibleName("Name: One");

    // Ctrl A takes every cell; Escape gives the range up.
    await page.keyboard.press("Control+a");
    await expect(selected).toHaveCount(30);
    await expect(statistics).toContainText("of 30");
    await page.keyboard.press("Escape");
    await expect(selected).toHaveCount(1);

    // A row's menu: its link, a row under it, the row moved down, opened,
    // and copied.
    await names.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy row link" }).click();
    await expect(page.getByText("Link copied")).toBeVisible();
    await names.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Insert a row below" }).click();
    await expect(names).toHaveCount(7);
    await expect(names.nth(2)).toHaveText("");
    await names.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move the row down" }).click();
    await expect(names.first()).toHaveText("Two");
    await expect(names.nth(1)).toHaveText("One");
    await names.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Expand row" }).click();
    await expect(panel.getByRole("heading", { name: "Two" })).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await names.first().click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .click();
    await expect(names).toHaveCount(8);
    await expect(names.nth(1)).toHaveText("Two");

    // The header's box ticks every row read, and they are let go at once.
    await page.getByRole("checkbox", { name: "Select 8 loaded rows" }).check();
    await expect(page.getByText("8 rows selected")).toBeVisible();
    await page.getByRole("button", { name: "Deselect" }).click();
    await expect(page.getByText("8 rows selected")).toHaveCount(0);

    // Taller rows, kept by the view.
    await page.getByRole("button", { name: "Row height" }).click();
    await page.getByRole("menuitem", { name: "Tall", exact: true }).click();
    await expect(names.first()).toHaveCSS("height", "88px");

    // A field dragged by its header onto another takes its place.
    const header = (label: string) =>
      page.getByRole("columnheader", { name: new RegExp(`^${label}`) });
    await expect(header("Amount")).toHaveAttribute("aria-colindex", "5");
    // The save of the fields' order, and not that of the rows' height just
    // before it: a view's saves go one after another, and the first to
    // answer after this line may still be the other.
    const stored = page.waitForResponse(
      (response) =>
        response.url().includes("catalog.updateView") &&
        (response.request().postData() ?? "").includes("fieldOrder") &&
        response.ok(),
    );
    await header("Amount").dragTo(header("Notes"));
    await expect(header("Amount")).toHaveAttribute("aria-colindex", "3");
    await expect(header("Notes")).toHaveAttribute("aria-colindex", "4");
    // The page shows a change at once and saves it behind: what is asked
    // of a reload is what was stored.
    await stored;
    await page.reload();
    await expect(header("Amount")).toHaveAttribute("aria-colindex", "3");
    await expect(names.first()).toHaveCSS("height", "88px");

    expect(blocked).toEqual([]);
  });

  test("offers the keyboard what the pointer drags: a field's place, its width, a series", async ({
    page,
  }) => {
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Kim Keys");
    const tableId = tableIdOf(page);
    await send(page, "catalog.addColumn", {
      tableId,
      name: "amount",
      label: "Amount",
      fieldType: "number",
    });
    await send(page, "rows.insertMany", {
      tableId,
      rows: [
        { name: "One", amount: "1" },
        { name: "Two", amount: "2" },
        { name: "Three" },
        { name: "Four" },
      ],
    });
    const amounts = cells(page, "amount");
    await expect(amounts).toHaveText(["1", "2", "", ""]);
    const grid = page.getByRole("grid");
    const headerAt = (place: number) =>
      page.locator(`[role="columnheader"][aria-colindex="${place + 2}"]`);
    const entry = (name: string) =>
      page.getByRole("menuitem", { name, exact: true });
    /** Opens the active field's menu, and picks an entry by typing it. */
    const pick = async (name: string) => {
      await page.keyboard.press("Alt+ArrowDown");
      await expect(page.getByRole("menu").locator(":focus")).toHaveCount(1);
      await page.keyboard.type(name.replace("…", ""));
      await expect(entry(name)).toBeFocused();
      await page.keyboard.press("Enter");
    };

    // The primary field stays first: its menu offers no move, and Escape
    // gives the keyboard back to the grid.
    await grid.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.getByRole("menu").locator(":focus")).toHaveCount(1);
    await expect(entry("Set the width…")).toBeVisible();
    await expect(entry("Move right")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(grid).toBeFocused();

    // The field beside it cannot go past it.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(entry("Move left")).toHaveAttribute("aria-disabled", "true");
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(grid).toBeFocused();

    // It moves, and the active cell moves with it.
    await pick("Move right");
    await expect(headerAt(2)).toContainText("Notes");
    await expect(headerAt(1)).toContainText("Status");
    await expect(grid).toBeFocused();
    await pick("Move left");
    await expect(headerAt(1)).toContainText("Notes");
    await expect(grid).toBeFocused();

    // At the last place, no further right.
    await page.keyboard.press("End");
    await page.keyboard.press("Alt+ArrowDown");
    await expect(entry("Move right")).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(grid).toBeFocused();

    // A width in figures: out of bounds it is refused and said.
    const amountHeader = headerAt(3);
    await expect(amountHeader).toContainText("Amount");
    const widthBefore = await amountHeader.evaluate(
      (element) => getComputedStyle(element).width,
    );
    await pick("Set the width…");
    const sizing = page.getByRole("dialog", { name: "Width of Amount" });
    const width = sizing.getByLabel("Width in pixels");
    await expect(width).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);
    for (const refused of ["59", "1201", "1e3"]) {
      await width.fill(refused);
      await page.keyboard.press("Enter");
      await expect(sizing.getByRole("alert")).toContainText("60 to 1200");
      await expect(width).toHaveAttribute("aria-invalid", "true");
    }
    await expect(amountHeader).toHaveCSS("width", widthBefore);
    await width.fill("240");
    await page.keyboard.press("Enter");
    await expect(sizing).toHaveCount(0);
    await expect(amountHeader).toHaveCSS("width", "240px");
    await expect(grid).toBeFocused();

    // A series goes on, by as many rows as there are under it and no more.
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu").locator(":focus")).toHaveCount(1);
    await page.keyboard.type("Continue");
    await expect(entry("Continue the series…")).toBeFocused();
    await page.keyboard.press("Enter");
    const series = page.getByRole("dialog", { name: "Continue the series" });
    const count = series.getByLabel("Rows to fill below");
    await expect(count).toBeFocused();
    await count.fill("3");
    await page.keyboard.press("Enter");
    await expect(series.getByRole("alert")).toContainText("1 to 2");
    await expect(amounts).toHaveText(["1", "2", "", ""]);
    await count.fill("2");
    await page.keyboard.press("Enter");
    await expect(series).toHaveCount(0);
    await expect(amounts).toHaveText(["1", "2", "3", "4"]);
    await expect(grid).toBeFocused();

    // Under the last row there is nothing to fill.
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Shift+F10");
    await expect(entry("Continue the series…")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");

    expect(blocked).toEqual([]);
  });

  test("keeps the keyboard's menus right on a wide and long table", async ({
    page,
  }) => {
    await signUpWithTable(page, "Kit Keys");
    const tableId = tableIdOf(page);
    for (let index = 0; index < 24; index += 1) {
      await send(page, "catalog.addColumn", {
        tableId,
        name: `extra_${index}`,
        label: `Extra ${index}`,
        fieldType: "text",
      });
    }
    for (let batch = 0; batch < 3; batch += 1) {
      await send(page, "rows.insertMany", {
        tableId,
        rows: Array.from({ length: 400 }, (_, index) => ({
          name: `Row ${batch}-${index}`,
        })),
      });
    }
    const grid = page.getByRole("grid");
    const notesMenu = page.getByRole("button", { name: "Notes field menu" });
    const entry = (name: string) =>
      page.getByRole("menuitem", { name, exact: true });
    await expect(notesMenu).toBeVisible();
    await expect(cells(page, "name").first()).toHaveText("Row 0-0");

    // The active cell's field has scrolled away: its menu still opens.
    await grid.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect(grid).toHaveAttribute("aria-activedescendant", /.+/);
    await grid.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(notesMenu).toHaveCount(0);
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.getByRole("menu").locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(grid).toBeFocused();

    // A dialog opened from that menu does not leave the next menu, opened
    // by the pointer, sending the keyboard to the grid when it closes.
    await page.keyboard.press("Alt+ArrowDown");
    await expect(entry("Edit field")).toBeVisible();
    await page.keyboard.type("Edit");
    await expect(entry("Edit field")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await notesMenu.click();
    await expect(entry("Edit field")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    await expect(notesMenu).toBeFocused();

    // A series reaches a thousand rows at most, however many lie below.
    await grid.focus();
    await page.keyboard.press("Shift+F10");
    await page.keyboard.type("Continue");
    await expect(entry("Continue the series…")).toBeFocused();
    await page.keyboard.press("Enter");
    const series = page.getByRole("dialog", { name: "Continue the series" });
    const count = series.getByLabel("Rows to fill below");
    await count.fill("1001");
    await page.keyboard.press("Enter");
    await expect(series.getByRole("alert")).toContainText("1 to 1000");
    await page.keyboard.press("Escape");
    await expect(series).toHaveCount(0);
  });
});
