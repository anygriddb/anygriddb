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
test.use({
  extraHTTPHeaders: { "x-forwarded-for": "198.51.100.60" },
  // The last journey answers for two sites that frame a link. Chromium
  // takes them for public sites asking for a page of this machine, and
  // refuses that before any policy is read: a real site and its instance
  // are on the same side of that line, so the check is left out here.
  launchOptions: {
    args: [
      "--ignore-certificate-errors",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  },
});

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

// A link that names a site may be shown there in a frame (ADR 0067), and
// nowhere else: the browser itself refuses any other site.
test("a public form is embedded in the site its link names, and in no other", async ({
  page,
  browser,
}) => {
  await signUpWithTable(page, "Ines Embedder");
  await page.getByRole("button", { name: "New view" }).click();
  await page.getByRole("menuitem", { name: "Form" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Share view" }).click();
  const sharing = page.getByRole("dialog");
  // Not the address of a site: refused, and nothing is made.
  const sites = sharing.getByLabel("Sites that may embed it (optional)");
  await sites.fill("http://portal.example.org");
  await sharing.getByRole("button", { name: "Create a link" }).click();
  await expect(
    page.getByText(
      "A site that embeds a link is an address starting with https://",
    ),
  ).toBeVisible();
  await sites.fill("https://portal.example.org");
  await sharing.getByRole("button", { name: "Create a link" }).click();
  await expect(
    sharing.getByRole("button", { name: "Copy the embed code" }),
  ).toBeVisible();
  const link = (await sharing.locator("code").first().textContent()) ?? "";
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{32,64}$/);
  await expect(
    sharing.getByText("Embedded in https://portal.example.org"),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");

  // Two sites that frame the link: pages of their own, at their own
  // addresses, answered here in place of servers that do not exist.
  const anonymous = await browser.newContext(from("198.51.100.63"));
  const host = `<!doctype html><title>Site</title><iframe src="${link}" title="Form" style="width: 900px; height: 700px"></iframe>`;
  for (const site of ["portal.example.org", "elsewhere.example.org"]) {
    await anonymous.route(`https://${site}/`, (route) =>
      route.fulfill({ contentType: "text/html", body: host }),
    );
  }
  const named = await anonymous.newPage();
  await named.goto("https://portal.example.org/");
  const framed = named.frameLocator("iframe");
  await framed.getByLabel("Name").fill("Framed answer");
  await framed.getByRole("button", { name: "Submit" }).click();
  await expect(
    framed.getByText("Thank you, your response was saved."),
  ).toBeVisible();

  const other = await anonymous.newPage();
  const refused: string[] = [];
  other.on("console", (message) => {
    if (message.text().includes("frame-ancestors"))
      refused.push(message.text());
  });
  await other.goto("https://elsewhere.example.org/");
  await expect.poll(() => refused.length).toBeGreaterThan(0);
  await expect(
    other.frameLocator("iframe").getByRole("button", { name: "Submit" }),
  ).toHaveCount(0);
  await anonymous.close();
});
