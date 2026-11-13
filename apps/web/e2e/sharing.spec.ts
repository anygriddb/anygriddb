import { expect, test } from "@playwright/test";
import {
  accessibilityViolations,
  signUp,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

/**
 * Addresses of their own: this journey makes two accounts, and sign-ups
 * are counted per client address, which the other journeys share.
 */
const from = (address: string) => ({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { "x-forwarded-for": address },
});
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.60" } });

// A role given to an address: the owner is told the same thing whether or
// not the address has an account, and the person who has one finds the
// invitation on their home page and accepts it there, without a link.
test("an owner invites an address, and its account accepts from its home page", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);

  await signUpWithTable(page, "Olive Owner");
  // The person invited already has an account, made in their own browser.
  // The owner comes first: an instance's first account administers it, and
  // an administrator is asked for a second factor before anything else.
  const own = await browser.newContext(from("198.51.100.61"));
  const guest = await own.newPage();
  const stamp = uniqueStamp();
  const guestEmail = `e2e-guest-${stamp}@example.com`;
  await signUp(guest, {
    email: guestEmail,
    name: `Guest ${stamp}`,
    password: "correct-horse-battery",
  });

  const base = /\/b\/[^/]+/.exec(page.url())?.[0] ?? "";
  await page.goto(`${base}/settings`);
  await page.getByLabel("Invite by email").fill(guestEmail);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  // Not "Access granted": nothing says the address has an account.
  await expect(page.getByText(/^Invitation (emailed|created)$/)).toBeVisible();
  await expect(page.getByText(guestEmail)).toBeVisible();

  await guest.goto("/");
  const invitations = guest.getByRole("region", { name: "Invitations" });
  await expect(
    invitations.getByText("Olive Owner invites you to Lab as Editor"),
  ).toBeVisible();
  expect(await accessibilityViolations(guest)).toEqual([]);
  await invitations.getByRole("button", { name: "Accept" }).click();
  await expect(guest.getByText("You joined Lab")).toBeVisible();
  await expect(invitations).toBeHidden();
  await expect(
    guest
      .getByRole("navigation", { name: "Bases" })
      .getByRole("link", { name: "Lab" }),
  ).toBeVisible();

  await own.close();
  expect(blocked).toEqual([]);
});

// A public form takes files: each is sent as it is chosen, by someone with
// no account, and the row the answer writes holds it.
test("a public form takes a file, and the row it writes holds it", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Fern Former");
  const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  const added = await page.request.post("/trpc/catalog.addColumn", {
    data: { tableId, name: "files", label: "Pièces", fieldType: "attachment" },
  });
  expect(added.ok(), await added.text()).toBe(true);

  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("menuitem", { name: "Form" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  // In the app's own form, the field is named by its label.
  await expect(page.getByRole("group", { name: "Pièces" })).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Share view" }).click();
  const sharing = page.getByRole("dialog");
  await sharing.getByRole("button", { name: "Create a link" }).click();
  const link = (await sharing.locator("code").textContent()) ?? "";
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{32,64}$/);
  await page.keyboard.press("Escape");

  const anonymous = await browser.newContext(from("198.51.100.62"));
  const visitor = await anonymous.newPage();
  await visitor.goto(link);
  const files = visitor.getByRole("group", { name: "Pièces" });
  await expect(files).toBeVisible();
  expect(await accessibilityViolations(visitor)).toEqual([]);
  const chooser = visitor.waitForEvent("filechooser");
  await files.getByRole("button", { name: "Add a file" }).click();
  await (
    await chooser
  ).setFiles({
    name: "devis.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Bon pour accord"),
  });
  await expect(files.getByText("devis.txt")).toBeVisible();
  expect(await accessibilityViolations(visitor)).toEqual([]);
  await visitor.getByRole("button", { name: "Submit" }).click();
  await expect(
    visitor.getByText("Thank you, your response was saved."),
  ).toBeVisible();
  await anonymous.close();

  await page.getByRole("link", { name: "Grid", exact: true }).click();
  await expect(
    page.locator('[role="gridcell"][data-column="files"]').first(),
  ).toContainText("devis.txt");
  expect(blocked).toEqual([]);
});
