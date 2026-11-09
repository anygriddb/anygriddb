import { expect, test } from "@playwright/test";
import { signUpWithTable, watchPolicy } from "./setup.ts";

// The formula editor (ADR 0021): completion of fields and functions,
// an error placed where the formula fails, and the computed column.
test("a formula field written with completion computes in the grid", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Formula User");

  await page.getByRole("button", { name: "Add a row" }).click();
  await page.locator('[role="gridcell"][data-column="name"]').first().click();
  const saved = page.waitForResponse(
    (response) => response.url().includes("rows.updateMany") && response.ok(),
  );
  await page.keyboard.type("abcd");
  await page.keyboard.press("Enter");
  await saved;

  await page.getByRole("button", { name: "Add a field" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Field name").fill("Longueur");
  await dialog.getByLabel("Type").selectOption("formula");
  const create = dialog.getByRole("button", { name: "Create field" });
  const editor = dialog.getByRole("textbox", { name: "Formula" });
  // An empty formula is not sent.
  await expect(create).toBeDisabled();
  // CodeMirror loads with the first formula.
  await expect(editor).toBeVisible();

  // The palette says what a function does, found by what it does, and
  // writes it with the cursor between its parentheses.
  const help = dialog.getByTestId("formula-fn-help");
  await dialog.getByLabel("Search functions").fill("characters");
  const len = dialog.getByRole("button", { name: "LEN", exact: true });
  await len.hover();
  await expect(help).toContainText("LEN(text)");
  await expect(help).toContainText("The number of characters.");
  await expect(help).toContainText("LEN({Name})");
  await len.click();
  await expect(editor).toHaveText("LEN()");
  await page.keyboard.type("1");
  await expect(editor).toHaveText("LEN(1)");
  await dialog.getByLabel("Search functions").fill("");

  // An unknown function is named under the editor, underlined, and not
  // sent.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("LENN(");
  const status = dialog.getByRole("status");
  await expect(status).toHaveText(/LENN/);
  await expect(dialog.locator(".cm-lintRange-error")).toHaveCount(1);
  await expect(create).toBeDisabled();

  // Start again with completion: a function, then a field.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("le");
  await dialog.getByRole("option", { name: /^LEN/ }).click();
  await page.keyboard.type("{N");
  await dialog.getByRole("option", { name: "{Name}" }).click();
  await expect(editor).toHaveText("LEN({Name})");
  await expect(status).toHaveText("");

  await create.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[role="gridcell"][aria-label^="Longueur:"]').first(),
  ).toHaveAttribute("aria-label", "Longueur: 4");
  expect(blocked).toEqual([]);
});
