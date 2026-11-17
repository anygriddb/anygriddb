import { expect, test, type Page } from "@playwright/test";
import {
  accessibilityViolations,
  pickFieldType,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

/** Sends a change to the API with the page's session, as the app does. */
async function send(page: Page, path: string, data: unknown): Promise<void> {
  const response = await page.request.post(`/trpc/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

const cells = (page: Page, column: string) =>
  page.locator(`[role="gridcell"][data-column="${column}"]`);

// The field dialog: each kind of field made as a person makes it, with its
// settings; the dialog opened again shows them as they were kept, and the
// grid draws its values by them. A window wide enough to draw every field
// at once: a grid draws only the columns in view. It makes an account, so
// it takes a client address of its own.
test.describe("the field dialog", () => {
  test.use({
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.88" },
    viewport: { width: 3600, height: 900 },
  });

  test("makes each kind of field with its settings, and changes them", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const blocked = watchPolicy(page);
    await signUpWithTable(page, "Fiona Fields");
    const samples = page.url();
    const tableId = /\/t\/([0-9a-f-]{36})/.exec(samples)?.[1] ?? "";
    const dialog = page.getByRole("dialog");
    const header = (label: string) =>
      page.getByRole("columnheader", { name: new RegExp(`^${label}`) });

    /** Opens the dialog on a new field, named and typed: a text if not. */
    const newField = async (name: string, type?: string) => {
      await page.getByRole("button", { name: "Add a field" }).click();
      await dialog.getByLabel("Field name").fill(name);
      if (type) await pickFieldType(page, dialog, type);
    };
    const create = async () => {
      await dialog.getByRole("button", { name: "Create field" }).click();
      await expect(dialog).toBeHidden();
    };
    const edit = async (name: string) => {
      await page
        .getByRole("button", { name: `${name} field menu`, exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit field" }).click();
      await expect(dialog.getByLabel("Field name")).toHaveValue(name);
    };
    const cancel = async () => {
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    };

    // A second table, with a row, for the links to reach.
    await page.getByRole("button", { name: "Add a table" }).click();
    await dialog.getByLabel("Table name").fill("Projects");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
    const projects = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    await send(page, "rows.insertMany", {
      tableId: projects,
      rows: [{ name: "Apollo" }],
    });
    await page.goto(samples);
    await page.getByRole("grid").waitFor();

    // A list of options: each named once, coloured, and drawn as asked.
    await newField("Stage", "Single select");
    const option = dialog.getByLabel("New option");
    await option.fill("Open");
    await option.press("Enter");
    await option.fill("Closed");
    await option.press("Enter");
    await option.fill("Open");
    await option.press("Enter");
    await expect(dialog.getByLabel("Option name")).toHaveCount(2);
    await option.fill("");
    // The options keep the order they are put in: the last one moved up,
    // from the keyboard, which stays on the button it pressed.
    const names = dialog.getByLabel("Option name");
    await expect(names.first()).toHaveValue("Open");
    const up = dialog.getByRole("button", { name: "Move Closed up" });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(names.first()).toHaveValue("Closed");
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute("aria-disabled", "true");
    // An option's colour is one swatch, which opens the ten.
    await dialog.getByRole("button", { name: "Colour of Open: Grey" }).click();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("radio", { name: "Purple" }).click();
    await expect(
      dialog.getByRole("button", { name: "Colour of Open: Purple" }),
    ).toBeVisible();
    await dialog.getByLabel("Display").selectOption({ label: "Radio buttons" });
    expect(await accessibilityViolations(page)).toEqual([]);
    await create();

    // A number as money.
    await newField("Price", "Number");
    await dialog.getByLabel("Format").selectOption({ label: "Currency" });
    await dialog.getByLabel("Decimals").selectOption("2");
    await dialog.getByLabel("Currency", { exact: true }).last().fill("usd");
    await create();

    // A day, written as the standard writes it.
    await newField("Due", "Date");
    await dialog.getByLabel("Date format").selectOption("iso");
    await create();

    // A score out of three hearts.
    await newField("Score", "Rating");
    await dialog.getByLabel("Maximum rating").selectOption("3");
    await dialog.getByLabel("Icon").selectOption({ label: "Heart" });
    await dialog.getByLabel("Colour").selectOption("red");
    await create();

    // A length of time, to the second.
    await newField("Length", "Duration");
    await dialog.getByLabel("Format").selectOption("h:mm:ss");
    await create();

    // Several people, who are not told.
    await newField("Owners", "Collaborator");
    await dialog.getByLabel("Allow several people").check();
    await dialog.getByLabel("Notify people when they are assigned").uncheck();
    await create();

    // A button that opens an address made from the row.
    await newField("Go", "Button");
    await dialog.getByLabel("Button text").fill("Open it");
    await dialog.getByLabel("URL").fill("https://example.org/{{record_id}}");
    await dialog
      .getByRole("button", { name: "Colour of the button: Blue" })
      .click();
    await page.getByRole("radio", { name: "Red" }).click();
    expect(await accessibilityViolations(page)).toEqual([]);
    await create();

    // A checkbox drawn as a switch.
    await newField("Ok", "Checkbox");
    await dialog.getByLabel("Display").selectOption({ label: "Switch" });
    await create();

    // A link to the other table, which gets the field that leads back.
    await newField("Project", "Link to another table");
    await dialog.getByLabel("Linked table").selectOption({ label: "Projects" });
    await expect(
      dialog.getByLabel("Also create the inverse field in the other table"),
    ).toBeChecked();
    await create();

    // A field of the linked rows, and a count of them under a condition.
    await newField("Project name", "Lookup");
    await dialog.getByLabel("Through link").selectOption({ label: "Project" });
    await dialog.getByLabel("Field to look up").selectOption({ label: "Name" });
    await create();
    await newField("Projects kept", "Rollup");
    await dialog.getByLabel("Through link").selectOption({ label: "Project" });
    await dialog.getByLabel("Field to look up").selectOption({ label: "Name" });
    await dialog
      .getByLabel("Aggregation")
      .selectOption({ label: "Count of values" });
    await dialog.getByRole("button", { name: "Add a condition" }).click();
    await dialog.getByLabel("Value").fill("Apollo");
    expect(await accessibilityViolations(page)).toEqual([]);
    await create();

    // A text nobody else may hold, described, and one that names the row.
    await newField("Ref");
    await dialog.getByLabel("Unique values").check();
    await dialog.getByLabel("Description").fill("A reference of its own");
    await create();
    await expect(
      header("Ref").getByTitle("A reference of its own"),
    ).toBeVisible();
    await newField("Title");
    await dialog.getByLabel("Primary field").check();
    await create();
    await expect(header("Title ?, Primary field")).toHaveAttribute(
      "aria-colindex",
      "2",
    );

    // The grid draws each value by its field's settings.
    await send(page, "rows.insertMany", {
      tableId,
      rows: [
        {
          title: "First",
          name: "A",
          notes: "abc",
          stage: "Open",
          price: "1234.5",
          due: "2026-03-04",
          ref: "R1",
        },
        { title: "Second", name: "B", notes: "12", ref: "R2" },
      ],
    });
    await expect(cells(page, "title")).toHaveText(["First", "Second"]);
    await expect(cells(page, "stage").first()).toHaveText("Open");
    await expect(cells(page, "price").first()).toContainText("1,234.50");
    await expect(cells(page, "due").first()).toHaveText("2026-03-04");
    await expect(
      cells(page, "go").first().getByRole("button", { name: "Open it" }),
    ).toBeVisible();

    // A value another row holds is refused where values are unique.
    await cells(page, "ref").nth(1).click();
    await page.keyboard.type("R1");
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Duplicate values prevent uniqueness"),
    ).toBeVisible();
    await page.reload();
    await expect(cells(page, "ref")).toHaveText(["R1", "R2"]);

    // Opened again, each dialog shows what was kept.
    await edit("Stage");
    await expect(dialog.getByLabel("Display")).toHaveValue("radio");
    await expect(dialog.getByLabel("Option name")).toHaveCount(2);
    await expect(dialog.getByLabel("Option name").first()).toHaveValue(
      "Closed",
    );
    await expect(
      dialog.getByRole("button", { name: "Colour of Open: Purple" }),
    ).toBeVisible();
    await expect(dialog.getByText("API key")).toContainText("stage");
    // An option renamed takes the rows that held it along.
    await dialog.getByLabel("Option name").nth(1).fill("Opened");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(cells(page, "stage").first()).toHaveText("Opened");
    await edit("Price");
    await expect(dialog.getByLabel("Format")).toHaveValue("currency");
    await expect(dialog.getByLabel("Decimals")).toHaveValue("2");
    await expect(
      dialog.getByLabel("Currency", { exact: true }).last(),
    ).toHaveValue("USD");
    await cancel();
    await edit("Due");
    await expect(dialog.getByLabel("Date format")).toHaveValue("iso");
    await cancel();
    await edit("Score");
    await expect(dialog.getByLabel("Maximum rating")).toHaveValue("3");
    await expect(dialog.getByLabel("Icon")).toHaveValue("heart");
    await expect(dialog.getByLabel("Colour")).toHaveValue("red");
    await cancel();
    await edit("Length");
    await expect(dialog.getByLabel("Format")).toHaveValue("h:mm:ss");
    await cancel();
    await edit("Owners");
    await expect(dialog.getByLabel("Allow several people")).toBeChecked();
    await expect(
      dialog.getByLabel("Notify people when they are assigned"),
    ).not.toBeChecked();
    await cancel();
    await edit("Go");
    await expect(dialog.getByLabel("Button text")).toHaveValue("Open it");
    await expect(dialog.getByLabel("URL")).toHaveValue(
      "https://example.org/{{record_id}}",
    );
    await expect(
      dialog.getByRole("button", { name: "Colour of the button: Red" }),
    ).toBeVisible();
    await cancel();
    await edit("Ok");
    await expect(dialog.getByLabel("Display")).toHaveValue("switch");
    await cancel();
    await edit("Projects kept");
    await expect(dialog.getByLabel("Value")).toHaveValue("Apollo");
    await cancel();
    await edit("Ref");
    await expect(dialog.getByLabel("Unique values")).toBeChecked();
    await expect(dialog.getByLabel("Description")).toHaveValue(
      "A reference of its own",
    );
    await cancel();

    // The first field takes its place back, from its own dialog.
    await edit("Name");
    await dialog.getByLabel("Primary field").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(header("Name ?, Primary field")).toHaveAttribute(
      "aria-colindex",
      "2",
    );

    // A type changed where a value cannot follow says how many are lost,
    // and asks before it clears them.
    await edit("Notes");
    await pickFieldType(page, dialog, "Number");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      /1 value out of \d+ cannot be converted and will be cleared\. Save anyway\?/,
    );
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Convert" }).click();
    await expect(dialog).toBeHidden();
    await expect(cells(page, "notes")).toHaveText(["", "12"]);

    // The other table has the field that leads back here.
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(header("Samples")).toBeVisible();

    expect(blocked).toEqual([]);
  });
});
