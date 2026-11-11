import { expect, test } from "@playwright/test";
import {
  accessibilityViolations,
  signUpWithTable,
  watchPolicy,
} from "./setup.ts";

// The API page tries the REST API with the reader's session, with no
// third-party explorer: a row written there shows in the grid.
test("the API page lists and creates rows with the reader's session", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Api User");
  const baseId = /\/b\/([^/]+)/.exec(page.url())?.[1] ?? "";
  await page.goto(`/b/${baseId}/api`);
  await page.getByRole("heading", { name: "Read rows" }).waitFor();
  // The examples wider than the page scroll by keyboard too.
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.getByRole("tab", { name: "Try it" }).click();
  await page.getByLabel("Operation").selectOption("create");
  await page
    .getByLabel("Body")
    .fill(JSON.stringify({ records: [{ fields: { name: "Acme" } }] }));
  await page.getByRole("button", { name: "Submit" }).click();
  const answer = page.getByTestId("api-answer");
  await expect(answer).toContainText('"records"');
  await expect(page.getByText("200", { exact: true })).toBeVisible();

  await page.getByLabel("Operation").selectOption("list");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(answer).toContainText('"Acme"');

  await page.getByRole("tab", { name: "MCP (AI)" }).click();
  await expect(page.getByText(/\/mcp/).first()).toBeVisible();
  expect(blocked).toEqual([]);
});
