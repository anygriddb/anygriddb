import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  accessibilityViolations,
  enableTotp,
  findAccount,
  mailedLink,
  mailedMessage,
  openAdmin,
  proveItIsYou,
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

    // Every public link and calendar feed of the instance, in one list.
    await openAdmin(page, "Sharing", "Links and feeds");
    await expect(
      page.getByText(/Public links let anyone with the address/),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    // Every base, and one base's own page: the administrator's, since
    // another journey's base must not leave under its feet.
    await openAdmin(page, "Bases");
    await page.getByLabel("Search bases").fill("Lab");
    const ownBase = page
      .getByRole("row", { name: /Admin Controls/ })
      .getByRole("link")
      .first();
    await expect(ownBase).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await ownBase.click();
    await page.waitForURL(/\/admin\/bases\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // From that page a role is given to someone, then taken away
    // (ROADMAP #69).
    await page.getByRole("button", { name: "Give a role to someone" }).click();
    await page.getByLabel("Find an account").fill(`Member ${stamp}`);
    await page.getByRole("option", { name: new RegExp(memberEmail) }).click();
    await page.getByLabel(`Role for Member ${stamp}`).selectOption("editor");
    await page.getByRole("button", { name: "Give the role" }).click();
    // The first change of this journey: Administration asks for the proof
    // (ADR 0073), once for the five minutes that follow.
    await proveItIsYou(page);
    await expect(page.getByText(`Role given to Member ${stamp}`)).toBeVisible();
    const given = page.getByRole("row", { name: new RegExp(memberEmail) });
    await expect(given.getByLabel(`Role for Member ${stamp}`)).toHaveValue(
      "editor",
    );
    expect(await accessibilityViolations(page)).toEqual([]);
    await given.getByRole("button", { name: `Remove Member ${stamp}` }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(given).toBeHidden();

    // The base goes to the trash from its page, and comes back from the
    // list of deleted bases (ROADMAP #22).
    await page.getByRole("button", { name: "Move to the trash" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Move to the trash" })
      .click();
    await page.waitForURL(/\/admin\/bases$/);
    const deleted = page
      .getByRole("region", { name: "Deleted bases" })
      .getByRole("listitem")
      .filter({ hasText: "by Admin Controls" });
    await expect(deleted).toHaveCount(1);
    expect(await accessibilityViolations(page)).toEqual([]);
    await deleted.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Restored from the trash")).toBeVisible();
    await expect(deleted).toHaveCount(0);

    // And every API token, webhook, and automation.
    await openAdmin(page, "Sharing", "Tokens and automations");
    await expect(
      page.getByRole("heading", { name: "API tokens" }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

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
    // Alerts and backups (ROADMAP #17, #25): nothing is open, nothing
    // was reported, and a threshold is changed from there.
    await expect(page.getByText("No alert is open.")).toBeVisible();
    await expect(
      page.getByText(/No backup has been reported yet/),
    ).toBeVisible();
    const backupDelay = page.getByLabel("No backup has succeeded for");
    await expect(backupDelay).toHaveValue("36");
    await backupDelay.selectOption("24");
    await expect(backupDelay).toHaveValue("24");
    // Kept by the server: the page says the same once read again.
    await page.reload();
    await expect(backupDelay).toHaveValue("24");
    await backupDelay.selectOption("36");
    await expect(backupDelay).toHaveValue("36");
    // What this administrator is told about is theirs to choose (#48):
    // spared a kind, the page says so once read again.
    const locks = page.getByLabel("An account that locks");
    await expect(locks).toBeChecked();
    // A click, then the state it leads to: the box follows a frame later.
    await locks.click();
    await expect(locks).not.toBeChecked();
    await page.reload();
    await expect(locks).not.toBeChecked();
    await locks.click();
    await expect(locks).toBeChecked();
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(await accessibilityViolations(page)).toEqual([]);

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

    // A person made an administrator is administration given. The proof
    // is still fresh from the role above, so it is not asked again.
    await page.getByRole("button", { name: "Add a person" }).click();
    const secondEmail = `e2e-second-${stamp}@example.com`;
    await adding.getByLabel("Display name").fill(`Second ${stamp}`);
    await adding.getByLabel("Email").fill(secondEmail);
    await adding.getByLabel("Administrator of the instance").check();
    await adding.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByText(
        `Second ${stamp} added. Their link went to ${secondEmail}`,
      ),
    ).toBeVisible();

    // The support role (ADR 0054), given from an account's menu. The
    // proof was given a moment ago, so it is not asked again; the trail
    // says who gave the role, and to whom.
    await findAccount(page, newcomerEmail);
    await page
      .getByRole("button", { name: `Actions for Newcomer ${stamp}` })
      .click();
    await page.getByRole("menuitem", { name: "Give the support role" }).click();
    await page
      .getByRole("dialog", { name: `Give Newcomer ${stamp} the support role?` })
      .getByRole("button", { name: "Give the role" })
      .click();
    await expect(page.getByText("Saved")).toBeVisible();
    await openAdmin(page, "Trails", "Sign-ins");
    await expect(
      page
        .getByRole("row", { name: new RegExp(`Newcomer ${stamp}`) })
        .filter({ hasText: "Given the support role" }),
    ).toContainText(`Ada ${stamp}`);
    await openAdmin(page, "People", "Accounts");

    // People from a file (ROADMAP #36): read and shown line by line
    // before anything is written. The line whose address has an account
    // says so; the two others are added, and their first link is mailed.
    await page.getByRole("button", { name: "Add from a file" }).click();
    const fromFile = page.getByRole("dialog", {
      name: "Add people from a file",
    });
    const filedEmail = `e2e-filed-a-${stamp}@example.com`;
    await fromFile.locator('input[type="file"]').setInputFiles({
      name: "people.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "email,name,bases",
          `${filedEmail},Filed A ${stamp},${baseName}:viewer`,
          `e2e-filed-b-${stamp}@example.com,Filed B ${stamp},`,
          `${newcomerEmail},Newcomer again,`,
        ].join("\n"),
      ),
    });
    await expect(
      fromFile.getByText("people.csv: 2 of 3 lines in order."),
    ).toBeVisible();
    await expect(
      fromFile.getByText("This address already has an account"),
    ).toBeVisible();
    await expect(fromFile.getByText(`${baseName}: Viewer`)).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await fromFile.getByRole("button", { name: "Add 2 people" }).click();
    await expect(
      page.getByText("2 people added. Their links are on their way by email."),
    ).toBeVisible();
    expect(await mailedLink(filedEmail, "reset")).toContain("/reset/");

    // Both ticked and disabled together, as each would be from its row.
    await page.getByLabel("Search accounts").fill(`Filed`);
    await expect(page.getByText("2 accounts", { exact: true })).toBeVisible();
    await page.getByLabel("Select every account of this page").check();
    await page.getByRole("button", { name: "Disable 2 accounts" }).click();
    await page
      .getByRole("dialog", { name: "Disable 2 accounts?" })
      .getByRole("button", { name: "Disable", exact: true })
      .click();
    await expect(page.getByText("2 accounts disabled")).toBeVisible();
    // The list was on active accounts: they left it, and are among the
    // disabled, where nothing is left to tick.
    await page.getByLabel("Status").selectOption("disabled");
    await expect(page.getByText("2 accounts", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("row", { name: new RegExp(filedEmail) }),
    ).toContainText("Disabled");
    await expect(
      page.getByLabel("Select every account of this page"),
    ).toBeDisabled();
    await page.getByLabel("Status").selectOption("active");
    await page.getByLabel("Search accounts").fill("");

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

    // Groups made in Administration (ROADMAP #27): a group, its member,
    // and a role on the administrator's base, which has a name of its own
    // by now (as the member has: renamed above); then what the member may do there, and through what (#29).
    await openAdmin(page, "People", "Groups");
    await page.getByRole("button", { name: "New group" }).click();
    await page.getByLabel("Name", { exact: true }).fill(`Team ${stamp}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Group created")).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("link", { name: new RegExp(`Team ${stamp}`) }).click();
    await page.waitForURL(/\/admin\/people\/groups\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: "Add a member" }).click();
    await page.getByLabel("Find an account").fill(`Renamed ${stamp}`);
    await page.getByRole("option", { name: new RegExp(movedEmail) }).click();
    await expect(page.getByText("Member added")).toBeVisible();
    await page.getByRole("button", { name: "Give a role on a base" }).click();
    await page.getByLabel("Role", { exact: true }).selectOption("editor");
    await page.getByLabel("Find a base").fill(baseName);
    await page.getByRole("option", { name: baseName }).click();
    await expect(page.getByText(`Role given on ${baseName}`)).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // The member's page says the role, and that the group gives it.
    await openAdmin(page, "People", "Accounts");
    await findAccount(page, movedEmail);
    await page
      .getByRole("row", { name: new RegExp(movedEmail) })
      .getByRole("link", { name: `Renamed ${stamp}` })
      .click();
    await page.waitForURL(/\/admin\/people\/accounts\/[0-9a-f-]{36}$/);
    await expect(
      page.getByText(`Editor, through the group Team ${stamp}`),
    ).toBeVisible();
    await page.getByRole("button", { name: baseName }).click();
    await expect(page.getByText(`Group Team ${stamp}`).first()).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

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
    // What was typed is in order: before it goes, the administrator
    // proves it is them (ROADMAP #28), once for the minutes that follow.
    await expect(
      page.getByRole("dialog", { name: "Confirm it is you" }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await proveItIsYou(page);
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
        .getByRole("row", { name: /Account deleted/ })
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

// The auditor (ADR 0071): a role an administrator gives, with the proof.
// Whoever has it reads every page of Administration, exports the trail,
// and changes nothing: the controls are off, and the server refuses.
test("an auditor reads every page of Administration and changes nothing", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email: adminEmail } = await signUpWithTable(page, "Audit Admin");
    await control.query("update users set is_admin = true where email = $1", [
      adminEmail,
    ]);

    // Who will audit, with a second factor of their own: Administration
    // asks one of whoever opens it.
    const theirs = await browser.newContext(from("198.51.100.35"));
    const auditor = await theirs.newPage();
    const stamp = uniqueStamp();
    const auditorEmail = `e2e-auditor-${stamp}@example.com`;
    await signUp(auditor, {
      email: auditorEmail,
      name: `Auditor ${stamp}`,
      password: "correct-horse-battery",
    });
    await enableTotp(auditor);
    await auditor.goto("/admin");
    await expect(
      auditor.getByText("This page is for instance administrators."),
    ).toBeVisible();

    await page.goto("/admin/people/accounts");
    await findAccount(page, auditorEmail);
    await page
      .getByRole("button", { name: `Actions for Auditor ${stamp}` })
      .click();
    await page.getByRole("menuitem", { name: "Give the auditor role" }).click();
    await page
      .getByRole("dialog", { name: `Give Auditor ${stamp} the auditor role?` })
      .getByRole("button", { name: "Give the role" })
      .click();
    await proveItIsYou(page);
    await expect(page.getByText("Saved")).toBeVisible();

    // Every section is theirs to read, and the page says what they are.
    await auditor.goto("/admin");
    await expect(auditor.getByRole("note")).toContainText(
      "You read Administration as an auditor",
    );
    for (const section of [
      "People",
      "Security",
      "Connections",
      "Sources",
      "Bases",
      "Sharing",
      "Trails",
      "Instance",
    ]) {
      await expect(
        auditor
          .getByRole("navigation", { name: "Administration" })
          .getByRole("link", { name: section, exact: true }),
      ).toBeVisible();
    }
    expect(await accessibilityViolations(auditor)).toEqual([]);

    // Accounts: searched and read; nobody to add, and no action to take.
    await openAdmin(auditor, "People", "Accounts");
    await findAccount(auditor, adminEmail);
    await expect(
      auditor.getByRole("button", { name: "Add a person" }),
    ).toBeHidden();
    await auditor
      .getByRole("button", { name: "Actions for Audit Admin" })
      .click();
    await expect(
      auditor.getByRole("menuitem", { name: "Disable" }),
    ).toBeDisabled();
    await auditor.keyboard.press("Escape");
    expect(await accessibilityViolations(auditor)).toEqual([]);

    // A page that changes things shows them, switched off.
    await openAdmin(auditor, "People", "Groups");
    await expect(
      auditor.getByRole("button", { name: "New group" }),
    ).toBeDisabled();
    await openAdmin(auditor, "Instance");
    await expect(auditor.getByLabel("Announcement")).toBeDisabled();
    expect(await accessibilityViolations(auditor)).toEqual([]);

    // The bases of the instance, found by name.
    await openAdmin(auditor, "Bases");
    await auditor.getByLabel("Search bases").fill("Lab");
    await expect(
      auditor.getByRole("link", { name: "Lab", exact: true }).first(),
    ).toBeVisible();

    // The trail is exported, and says who gave them the role.
    await openAdmin(auditor, "Trails");
    const download = auditor.waitForEvent("download");
    await auditor.getByRole("button", { name: "Export as CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    await openAdmin(auditor, "Trails", "Sign-ins");
    await expect(
      auditor
        .getByRole("row", { name: new RegExp(`Auditor ${stamp}`) })
        .filter({ hasText: "Given the auditor role" }),
    ).toContainText("Audit Admin");

    // Asked past the page, the server answers the same: no.
    const refused = await auditor.evaluate(async () => {
      const answer = await fetch("/trpc/admin.updateSettings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ banner: "Not theirs to set" }),
      });
      return answer.status;
    });
    expect(refused).toBe(403);

    await theirs.close();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});

// An administrator's way into a base (ADR 0074): Administration shows what
// a base is made of, never its rows. To read them, an administrator opens
// the base for an hour and says why; they read and change nothing, and the
// base's owner is told at once, in the app and by email.
test("an administrator opens a base to read it, and its owner is told why", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    // Someone's base, made in their own browser.
    const theirs = await browser.newContext(from("198.51.100.36"));
    const owner = await theirs.newPage();
    const { email: ownerEmail } = await signUpWithTable(owner, "Opened Owner");
    await owner.getByRole("button", { name: "Add a row", exact: true }).click();
    const baseId = (
      await control.query<{ id: string }>(
        "select r.scope_id as id from role_bindings r join users u on u.id = r.user_id where u.email = $1 and r.scope = 'base' and r.role = 'owner'",
        [ownerEmail],
      )
    ).rows[0]?.id;
    expect(baseId).toBeTruthy();

    const { email } = await signUpWithTable(page, "Opening Admin");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    // Not a member: the base's address answers that there is no such base.
    await page.goto(`/admin/bases/${String(baseId)}`);
    const reading = page.getByRole("region", { name: "Reading the base" });
    await expect(
      reading.getByText(/Administration shows what a base is made of/),
    ).toBeVisible();
    await reading
      .getByRole("button", { name: "Open it to read, for an hour" })
      .click();
    // A change made in Administration asks for the proof (ADR 0073).
    await proveItIsYou(page);
    const asking = page.getByRole("dialog", {
      name: "Open this base to read it?",
    });
    await asking.getByLabel("Reason").fill("An invoice blocks the closing.");
    expect(await accessibilityViolations(page)).toEqual([]);
    await asking.getByRole("button", { name: "Open for an hour" }).click();
    await expect(
      page.getByText("The base is open to you for an hour"),
    ).toBeVisible();
    await expect(reading.getByText(/reads it until/)).toBeVisible();
    await expect(
      reading.getByText("An invoice blocks the closing."),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // They read the table, and nothing in it can be changed.
    await reading.getByRole("link", { name: "Go to the base" }).click();
    await page.getByRole("link", { name: "Samples" }).first().click();
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add a row", exact: true }),
    ).toHaveCount(0);

    // The owner is told in the app, with the reason, and by email.
    await owner.reload();
    await owner
      .getByRole("button", { name: /^Notifications \(\d+ unread\)$/ })
      .click();
    await owner
      .getByRole("button", {
        name: /^Opening Admin, an administrator, opened Lab to read it until .*An invoice blocks the closing\./,
      })
      .click();
    // It opens the base's members, where the opening is written too.
    await owner.waitForURL(new RegExp(`/b/${String(baseId)}/settings$`));
    await expect(
      owner
        .getByRole("status")
        .filter({ hasText: "is not a member and can read this base until" }),
    ).toContainText("An invoice blocks the closing.");
    expect(await accessibilityViolations(owner)).toEqual([]);
    const mail = await mailedMessage(ownerEmail, "an administrator opened");
    expect(mail.text).toContain("An invoice blocks the closing.");
    expect(mail.text).toContain("Opening Admin");

    // Closed by hand: the base is closed to the administrator again.
    await page.goto(`/admin/bases/${String(baseId)}`);
    await reading.getByRole("button", { name: "Close it now" }).click();
    await expect(
      page.getByText("The base is closed to you again"),
    ).toBeVisible();
    await expect(reading.getByText(/reads it until/)).toHaveCount(0);
    await owner.reload();
    await expect(
      owner
        .getByRole("status")
        .filter({ hasText: "is not a member and can read this base until" }),
    ).toHaveCount(0);

    // A role the administrator gives someone on that base is told to its
    // owner too (ROADMAP #91): who received which role, and from whom.
    const guestStamp = uniqueStamp();
    const guestEmail = `e2e-guest-${guestStamp}@example.com`;
    await control.query(
      "insert into users (email, display_name) values ($1, $2)",
      [guestEmail, `Guest ${guestStamp}`],
    );
    await page.getByRole("button", { name: "Give a role to someone" }).click();
    await page.getByLabel("Find an account").fill(`Guest ${guestStamp}`);
    await page.getByRole("option", { name: new RegExp(guestEmail) }).click();
    await page.getByRole("button", { name: "Give the role" }).click();
    await expect(
      page.getByText(`Role given to Guest ${guestStamp}`),
    ).toBeVisible();
    await owner.reload();
    await owner
      .getByRole("button", { name: /^Notifications \(\d+ unread\)$/ })
      .click();
    await expect(
      owner.getByRole("button", {
        name: new RegExp(
          `^Opening Admin, an administrator, gave Guest ${guestStamp} a role on Lab \\(Viewer\\)`,
        ),
      }),
    ).toBeVisible();
    expect(await accessibilityViolations(owner)).toEqual([]);

    await theirs.close();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});

// Handing a leaving person's work over (ROADMAP #21): the base they alone
// own gets an owner who stays, their account is left as it is, and the
// page says what moved.
test("an administrator hands a leaving person's base to someone who stays", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const theirs = await browser.newContext(from("198.51.100.37"));
    const leaving = await theirs.newPage();
    const { email: leavingEmail } = await signUpWithTable(
      leaving,
      "Leaving Lea",
    );
    await theirs.close();
    const { email } = await signUpWithTable(page, "Staying Admin");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    await page.goto("/admin/people/accounts");
    await findAccount(page, leavingEmail);
    await page.getByRole("button", { name: "Actions for Leaving Lea" }).click();
    await page
      .getByRole("menuitem", { name: "Hand over what they own…" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Hand over what Leaving Lea owns?",
    });
    // What there is, before anything is asked: the base they alone own.
    await expect(dialog.getByText("Bases owned alone")).toBeVisible();
    await expect(dialog.getByText("Lab", { exact: true })).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByLabel("Who takes over").fill("Staying Admin");
    await dialog.getByRole("option", { name: new RegExp(email) }).click();
    await dialog.getByRole("button", { name: "Hand over" }).click();
    // A change made in Administration asks for the proof (ADR 0073).
    await proveItIsYou(page);
    const done = page.getByRole("dialog", {
      name: "Handed over to Staying Admin",
    });
    await expect(
      done.getByText(/1 base, 0 automations, 0 webhooks/),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    await done.getByRole("button", { name: "Done" }).click();

    // The base has two owners now, the person who leaves still among them.
    const owners = await control.query<{ email: string }>(
      "select u.email from role_bindings r join users u on u.id = r.user_id where r.scope = 'base' and r.role = 'owner' and r.scope_id = (select r2.scope_id from role_bindings r2 join users u2 on u2.id = r2.user_id where u2.email = $1 and r2.scope = 'base' and r2.role = 'owner') order by u.email",
      [leavingEmail],
    );
    expect(owners.rows.map((row) => row.email).sort()).toEqual(
      [email, leavingEmail].sort(),
    );
    // Nothing is left to hand over: the dialog says so.
    await page.getByRole("button", { name: "Actions for Leaving Lea" }).click();
    await page
      .getByRole("menuitem", { name: "Hand over what they own…" })
      .click();
    await expect(
      page.getByText(/Nothing to hand over: no base owned alone/),
    ).toBeVisible();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});
