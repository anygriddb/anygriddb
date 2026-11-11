import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  accessibilityViolations,
  findAccount,
  mailedLink,
  openAdmin,
  signIn,
  signUp,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

/**
 * Addresses of their own. The e2e server trusts the loopback peer
 * (`ANYGRIDDB_TRUSTED_PROXIES`), so this header is the client address:
 * the accounts these journeys make do not spend the sign-in rate limit
 * the other journeys share.
 */
const from = (address: string) => ({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { "x-forwarded-for": address },
});
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.30" } });

// Instance controls (ADR 0042) an administrator uses beside everyone's
// work: sessions, the sign-in trail, an account's tokens, the access
// export. Maintenance, which signs everyone out, has its own journey.
test("an administrator ends a session, reads the sign-ins, and exports access", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Admin Controls");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    // Someone else signs up in their own browser.
    const other = await browser.newContext(from("198.51.100.31"));
    const member = await other.newPage();
    const stamp = uniqueStamp();
    const memberEmail = `e2e-member-${stamp}@example.com`;
    await signUp(member, {
      email: memberEmail,
      name: `Member ${stamp}`,
      password: "correct-horse-battery",
    });

    // The first page lists what needs action, nothing when nothing does.
    await page.goto("/admin");
    expect(await accessibilityViolations(page)).toEqual([]);
    await openAdmin(page, "People", "Sessions");
    const row = page.getByRole("row", { name: new RegExp(memberEmail) });
    await row.getByRole("button", { name: "End" }).click();
    await expect(page.getByText("Session ended")).toBeVisible();
    await expect(row).toBeHidden();
    await member.reload();
    await member.waitForURL(/\/login/);

    // The trail names who signed up, and who ended the session.
    await openAdmin(page, "Trails", "Sign-ins");
    const ended = page
      .getByRole("row", { name: new RegExp(`Member ${stamp}`) })
      .filter({ hasText: "Session ended" });
    await expect(ended).toContainText("Admin Controls");
    await expect(
      page
        .getByRole("row", { name: new RegExp(`Member ${stamp}`) })
        .filter({ hasText: "Sign-up" }),
    ).toBeVisible();

    // The list shows 50 accounts a page, and the e2e database keeps every
    // run's: the account is looked up.
    await openAdmin(page, "People", "Accounts");
    await findAccount(page, memberEmail);
    await page
      .getByRole("button", { name: `Actions for Member ${stamp}` })
      .click();
    await page
      .getByRole("menuitem", { name: "Revoke their API tokens" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(page.getByText("Done")).toBeVisible();

    // The account's page (ROADMAP #19), opened from its row, at an address
    // of its own. A name and an address corrected there: an address
    // another account has is refused, and the dialog keeps what was typed.
    const memberRow = page.getByRole("row", { name: new RegExp(memberEmail) });
    await memberRow.getByRole("link", { name: `Member ${stamp}` }).click();
    await page.waitForURL(/\/admin\/people\/accounts\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: `Member ${stamp}` }),
    ).toBeVisible();
    await expect(page.getByText("Made here")).toBeVisible();
    await expect(page.getByText("With a password")).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editing = page.getByRole("dialog", {
      name: `Edit Member ${stamp}'s account`,
    });
    await editing.getByLabel("Display name").fill(`Renamed ${stamp}`);
    await editing.getByLabel("Email").fill(email);
    await editing.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("This account already exists")).toBeVisible();
    await expect(editing).toBeVisible();
    const movedEmail = `e2e-moved-${stamp}@example.com`;
    await editing.getByLabel("Email").fill(movedEmail);
    await editing.getByRole("button", { name: "Save" }).click();
    await expect(editing).toBeHidden();
    await expect(
      page.getByRole("heading", { name: `Renamed ${stamp}` }),
    ).toBeVisible();
    await openAdmin(page, "People", "Accounts");
    await findAccount(page, movedEmail);
    await expect(
      page.getByRole("row", { name: new RegExp(movedEmail) }),
    ).toContainText(`Renamed ${stamp}`);
    // Their own name too, which the page shows at once.
    await findAccount(page, email);
    await page
      .getByRole("button", { name: "Actions for Admin Controls" })
      .click();
    await page.getByRole("menuitem", { name: "Edit name and email" }).click();
    const own = page.getByRole("dialog", {
      name: "Edit Admin Controls's account",
    });
    await own.getByLabel("Display name").fill(`Ada ${stamp}`);
    await own.getByRole("button", { name: "Save" }).click();
    await expect(own).toBeHidden();
    await expect(
      page.getByRole("button", { name: `Ada ${stamp}` }).first(),
    ).toBeVisible();
    await openAdmin(page, "Trails", "Sign-ins");
    await expect(
      page
        .getByRole("row", { name: new RegExp(`Renamed ${stamp}`) })
        .filter({ hasText: "Account changed" })
        .first(),
    ).toContainText(`Ada ${stamp}`);

    // Who has access is exported beside the security policy (ROADMAP #49).
    await openAdmin(page, "Security");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export who has access" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^anygriddb-access-.*\.csv$/);
    const csv = await readFile((await file.path()) ?? "", "utf8");
    expect(csv).toContain(movedEmail);
    expect(csv).toContain(email);

    await openAdmin(page, "Instance", "Support");
    // Operator notices need SMTP (ADR 0052): the journeys' server has it.
    await expect(
      page.getByRole("heading", { name: "Message accounts" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Set up email under Connections before you can send a notice.",
      ),
    ).toBeHidden();
    expect(await accessibilityViolations(page)).toEqual([]);

    // Which AnyGridDB runs (ADR 0048): the support bundle and Health say
    // it. This server runs from sources, so no commit or build time.
    const { version } = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const bundleDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download the support bundle" })
      .click();
    const bundle = JSON.parse(
      await readFile((await (await bundleDownload).path()) ?? "", "utf8"),
    ) as { health: { build: { version: string; commit: string | null } } };
    expect(bundle.health.build).toMatchObject({ version, commit: null });
    await openAdmin(page, "Instance", "Health");
    await expect(
      page
        .locator("dt", { hasText: /^Version$/ })
        .locator("xpath=following-sibling::dd[1]"),
    ).toHaveText(`${version} · from sources`);

    // Addresses keep the section, the page, and the list's filters
    // (ROADMAP #49); a section's own address opens its first page.
    await page.goto("/admin/people");
    await page.waitForURL(/\/admin\/people\/accounts$/);
    await page.goto("/admin/people/accounts?status=disabled&admin=no");
    await expect(page.getByLabel("Status")).toHaveValue("disabled");
    await expect(page.getByLabel("Administrator")).toHaveValue("no");
    await expect(
      page
        .getByRole("navigation", { name: "People" })
        .getByRole("link", { name: "Accounts" }),
    ).toHaveAttribute("aria-current", "page");
    await page
      .getByRole("navigation", { name: "People" })
      .getByRole("link", { name: "Sessions" })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "Administration" })
        .getByRole("link", { name: "People" }),
    ).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(page.getByLabel("Status")).toHaveValue("disabled");
    await page.getByLabel("Status").selectOption("active");
    await page.waitForURL(/status=active/);

    // Adding a person with a role on a base (ROADMAP #67, ADR 0057): the
    // base is found by name among the instance's, the first link is
    // mailed, and the person lands in the base once their password is set.
    const baseName = `Field ${stamp}`;
    await control.query(
      "update bases set name = $1 where id in (select r.scope_id from role_bindings r join users u on u.id = r.user_id where r.scope = 'base' and r.role = 'owner' and u.email = $2)",
      [baseName, email],
    );
    await page.getByRole("button", { name: "Add a person" }).click();
    const adding = page.getByRole("dialog", { name: "Add a person" });
    const newcomerEmail = `e2e-newcomer-${stamp}@example.com`;
    await adding.getByLabel("Display name").fill(`Newcomer ${stamp}`);
    await adding.getByLabel("Email").fill(newcomerEmail);
    await adding.getByRole("button", { name: "Add bases" }).click();
    await adding.getByLabel("Find a base").fill(baseName);
    await adding.getByRole("option", { name: baseName }).click();
    await adding.getByRole("button", { name: "Done" }).click();
    await adding
      .getByLabel(`Role on ${baseName}`)
      .selectOption({ label: "Editor" });
    expect(await accessibilityViolations(page)).toEqual([]);
    await adding.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByText(
        `Newcomer ${stamp} added. Their link went to ${newcomerEmail}`,
      ),
    ).toBeVisible();

    const theirs = await browser.newContext(from("198.51.100.34"));
    const newcomer = await theirs.newPage();
    await newcomer.goto(await mailedLink(newcomerEmail, "reset"));
    await newcomer
      .getByLabel("New password", { exact: true })
      .fill("a-first-long-passphrase");
    await newcomer
      .getByLabel("New password, again")
      .fill("a-first-long-passphrase");
    await newcomer.getByRole("button", { name: "Set the password" }).click();
    await expect(newcomer.getByText("Your password is changed")).toBeVisible();
    await signIn(newcomer, newcomerEmail, "a-first-long-passphrase");
    await newcomer.waitForURL((url) => !url.pathname.startsWith("/login"));
    await newcomer.goto("/");
    await expect(newcomer.getByText(baseName).first()).toBeVisible();
    await theirs.close();

    // From their page, the administrator changes the role, takes it away,
    // and gives it again (ROADMAP #68).
    await openAdmin(page, "People", "Accounts");
    await findAccount(page, newcomerEmail);
    await page.getByRole("link", { name: `Newcomer ${stamp}` }).click();
    const roleOn = page.getByLabel(`Role on ${baseName}`);
    await expect(roleOn).toHaveValue("editor");
    await roleOn.selectOption("viewer");
    await expect(page.getByText("Role changed")).toBeVisible();
    await expect(roleOn).toHaveValue("viewer");
    await page.getByRole("button", { name: `Remove from ${baseName}` }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(page.getByText(`Removed from ${baseName}`)).toBeVisible();
    await expect(roleOn).toBeHidden();
    await page.getByRole("button", { name: "Give a role on a base" }).click();
    await page.getByLabel("Find a base").fill(baseName);
    await page.getByRole("option", { name: baseName }).click();
    await page.getByLabel(`Role on ${baseName}`).selectOption("commenter");
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Give the role" }).click();
    await expect(page.getByText(`Role given on ${baseName}`)).toBeVisible();
    await expect(page.getByLabel(`Role on ${baseName}`)).toHaveValue(
      "commenter",
    );

    await other.close();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});

// A departure (ADR 0057 / 0051): Delete without disabling first. It alone
// owns a base, so the administrator names the colleague who takes it.
test("an administrator deletes a departed owner and names who takes the base", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email: adminEmail } = await signUpWithTable(page, "Erase Admin");
    await control.query("update users set is_admin = true where email = $1", [
      adminEmail,
    ]);

    // The person who will leave alone owns the base they make.
    const theirs = await browser.newContext(from("198.51.100.32"));
    const leaving = await theirs.newPage();
    const stamp = uniqueStamp();
    const { email: leavingEmail } = await signUpWithTable(
      leaving,
      `Leaving ${stamp}`,
    );

    // The colleague who takes the base.
    const other = await browser.newContext(from("198.51.100.33"));
    const heir = await other.newPage();
    const heirEmail = `e2e-heir-${stamp}@example.com`;
    await signUp(heir, {
      email: heirEmail,
      name: `Heir ${stamp}`,
      password: "correct-horse-battery",
    });

    await page.goto("/admin/people/accounts");
    await findAccount(page, leavingEmail);
    const row = page.getByRole("row", { name: new RegExp(leavingEmail) });
    // Delete is offered without disabling first.
    await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("No one else owns these bases: Lab.");
    expect(await accessibilityViolations(page)).toEqual([]);

    // Nothing typed, then no new owner, then an address no account has:
    // each is refused and the dialog stays.
    const erase = dialog.getByRole("button", { name: "Delete", exact: true });
    await erase.click();
    await expect(
      page.getByText("Type the account's email to confirm"),
    ).toBeVisible();
    await dialog
      .getByLabel(`Type ${leavingEmail} to confirm`)
      .fill(leavingEmail);
    await erase.click();
    await expect(page.getByText("Type the new owner's email")).toBeVisible();
    await dialog
      .getByLabel("New owner's email")
      .fill(`e2e-nobody-${stamp}@example.com`);
    await erase.click();
    await expect(page.getByText("No account with this email")).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("New owner's email").fill(heirEmail);
    await erase.click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeHidden();

    const gone = await control.query("select 1 from users where email = $1", [
      leavingEmail,
    ]);
    expect(gone.rowCount).toBe(0);
    const owners = await control.query(
      "select u.email from role_bindings r join users u on u.id = r.user_id join bases b on b.id = r.scope_id where r.scope = 'base' and r.role = 'owner' and b.name = 'Lab' and u.email in ($1, $2)",
      [heirEmail, leavingEmail],
    );
    expect(owners.rows).toEqual([{ email: heirEmail }]);

    // The trail says an administrator erased an account, not whose.
    await openAdmin(page, "Trails", "Sign-ins");
    await expect(
      page
        .getByRole("row", { name: /Account erased/ })
        .filter({ hasText: "Erase Admin" })
        .first(),
    ).toContainText("By an administrator");

    await theirs.close();
    await other.close();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});
