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
// The owner then keeps them to some rows and hides a field from them: the
// settings show the table as they read it, and their own grid agrees.
test("an owner invites an address, its account accepts, and reads what its permissions leave", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);

  await signUpWithTable(page, "Olive Owner");
  const tableId = /\/t\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  const tablePath = new URL(page.url()).pathname;
  for (const column of [
    { name: "unit_price", label: "Unit price", fieldType: "number" },
    { name: "seller", label: "Seller", fieldType: "text" },
  ]) {
    const added = await page.request.post("/trpc/catalog.addColumn", {
      data: { tableId, ...column },
    });
    expect(added.ok(), await added.text()).toBe(true);
  }
  const filled = await page.request.post("/trpc/rows.insertMany", {
    data: {
      tableId,
      rows: [
        { name: "Chair", seller: "ada", unit_price: "120" },
        { name: "Desk", seller: "bob", unit_price: "480" },
        { name: "Lamp", seller: "ada", unit_price: "35" },
      ],
    },
  });
  expect(filled.ok(), await filled.text()).toBe(true);
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
  // The role is named as the person will read it in the invitation.
  await page
    .locator("form", { has: page.getByLabel("Invite by email") })
    .getByRole("combobox", { name: "Role" })
    .selectOption({ label: "Commenter" });
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  // Not "Access granted": nothing says the address has an account.
  await expect(page.getByText(/^Invitation (emailed|created)$/)).toBeVisible();
  await expect(page.getByText(guestEmail)).toBeVisible();

  await guest.goto("/");
  const invitations = guest.getByRole("region", { name: "Invitations" });
  await expect(
    invitations.getByText("Olive Owner invites you to Lab as Commenter"),
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

  // Their permissions on the table. The settings are opened anew: the
  // list of members arrives after the panel, and "View as" answers at
  // once for the member it shows, who is the guest, not the owner, whom
  // no permission restricts.
  await page.goto(`${base}/settings`);
  const rules = page.getByRole("region", { name: "Permissions on Samples" });
  await expect(
    rules.getByLabel("Member whose permissions are set").getByRole("option"),
  ).toHaveText([`Guest ${stamp}`]);
  await rules.getByRole("button", { name: "View as" }).click();
  const preview = rules.getByRole("region", {
    name: `Preview: Guest ${stamp}`,
  });
  // Their role in words, and every row.
  await expect(preview.getByText("Commenter · 3 visible rows")).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  // Only the rows of one seller, and no price.
  await rules
    .getByLabel("Rows this member sees")
    .selectOption({ label: "Only the rows that match" });
  await rules.getByRole("button", { name: "Add a condition" }).click();
  await rules
    .getByLabel("Field", { exact: true })
    .selectOption({ label: "Seller" });
  await rules.getByLabel("Value").fill("ada");
  await rules
    .getByLabel("What this member may do with Unit price")
    .selectOption({ label: "Hidden" });
  await expect(
    preview.getByText("Changes not saved yet are not in this preview."),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await rules.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Permissions saved")).toBeVisible();
  // The table as they read it: two rows, the fields by their labels.
  await expect(preview.getByText("Commenter · 2 visible rows")).toBeVisible();
  await expect(preview.getByRole("columnheader")).toHaveText([
    "Name",
    "Notes",
    "Status",
    "Seller",
  ]);
  await expect(preview.getByRole("cell", { name: "Chair" })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "Lamp" })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "Desk" })).toHaveCount(0);
  expect(await accessibilityViolations(page)).toEqual([]);

  // Their own grid agrees.
  await guest.goto(tablePath);
  await expect(guest.getByRole("gridcell", { name: "Chair" })).toBeVisible();
  await expect(guest.getByRole("gridcell", { name: "Lamp" })).toBeVisible();
  await expect(guest.getByRole("gridcell", { name: "Desk" })).toHaveCount(0);
  await expect(
    guest.getByRole("columnheader", { name: /Unit price/ }),
  ).toHaveCount(0);

  // Kept: opened again, the settings show the rule and the hidden field.
  await page.reload();
  await expect(rules.getByLabel("Rows this member sees")).toHaveValue("some");
  await expect(
    rules.getByLabel("What this member may do with Unit price"),
  ).toHaveValue("hide");
  // Cleared, they read every row and field again.
  await rules.getByRole("button", { name: "Clear restrictions" }).click();
  await expect(page.getByText("Restrictions cleared")).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole("gridcell", { name: "Desk" })).toBeVisible();
  await expect(
    guest.getByRole("columnheader", { name: /Unit price/ }),
  ).toBeVisible();

  await own.close();
  expect(blocked).toEqual([]);
});

// A whole base read-only by one link (ROADMAP row 93): made from the
// base's settings, opened with no account, each table read; revoked, it
// opens no more.
test("an owner shares a whole base read-only, and anyone with the link reads it", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Bea Baseshare");
  await page.getByRole("button", { name: "Add a row", exact: true }).click();
  await page.locator('[role="gridcell"][data-column="name"]').first().click();
  const saved = page.waitForResponse(
    (response) => response.url().includes("rows.updateMany") && response.ok(),
  );
  await page.keyboard.type("Beatrix");
  await page.keyboard.press("Enter");
  await saved;

  const base = /\/b\/[^/]+/.exec(page.url())?.[0] ?? "";
  await page.goto(`${base}/settings`);
  await page.getByRole("button", { name: "Make a read-only link" }).click();
  const shown = page.locator("code").filter({ hasText: "/s/b/" });
  await expect(shown).toBeVisible();
  const link = (await shown.textContent()) ?? "";
  expect(await accessibilityViolations(page)).toEqual([]);

  const someone = await browser.newContext(from("198.51.100.64"));
  const reader = await someone.newPage();
  await reader.goto(link);
  await expect(reader.getByRole("heading", { name: "Lab" })).toBeVisible();
  await expect(
    reader
      .getByRole("navigation", { name: "Tables" })
      .getByRole("button", { name: "Samples" }),
  ).toBeVisible();
  await expect(reader.getByRole("cell", { name: "Beatrix" })).toBeVisible();
  // One row is counted as one.
  await expect(reader.getByText("1 row", { exact: true })).toBeVisible();
  // Someone without an account uses the software too: the notice of its
  // license is on their page.
  await reader.getByRole("button", { name: "About AnyGridDB" }).click();
  const about = reader.getByRole("dialog", { name: "About AnyGridDB" });
  await expect(about).toContainText("no warranty");
  await reader.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  expect(await accessibilityViolations(reader)).toEqual([]);

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await reader.reload();
  await expect(
    reader.getByText("This link does not exist, has expired, or was revoked."),
  ).toBeVisible();
  await someone.close();
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

  // The form's maker sets when its link takes answers. Once that time is
  // over, the link says so in place of the fields, and offers nothing to
  // send.
  await expect(page.getByText("Its link takes answers until")).toBeVisible();
  const viewId =
    /\/t\/[0-9a-f-]{36}\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
  const closed = await page.request.post("/trpc/catalog.updateView", {
    data: {
      viewId,
      patch: {
        form: { openUntil: new Date(Date.now() - 60_000).toISOString() },
      },
    },
  });
  expect(closed.ok(), await closed.text()).toBe(true);
  const later = await browser.newContext(from("198.51.100.63"));
  const late = await later.newPage();
  await late.goto(link);
  await expect(late.getByRole("status")).toContainText(
    /This form took answers until .+\. It is closed\./,
  );
  await expect(late.getByRole("button", { name: "Submit" })).toHaveCount(0);
  await expect(late.getByRole("group", { name: "Pièces" })).toHaveCount(0);
  expect(await accessibilityViolations(late)).toEqual([]);
  await later.close();

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
