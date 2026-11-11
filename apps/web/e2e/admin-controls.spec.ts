import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  accessibilityViolations,
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
    await member.goto("/signup");
    await member.getByLabel("Email").fill(memberEmail);
    await member.getByLabel("Display name").fill(`Member ${stamp}`);
    await member.getByLabel("Password").fill("correct-horse-battery");
    await member.getByRole("button", { name: "Create account" }).click();
    await member.waitForURL(/\/welcome/);

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Sessions" }).click();
    const row = page.getByRole("row", { name: new RegExp(memberEmail) });
    await row.getByRole("button", { name: "End" }).click();
    await expect(page.getByText("Session ended")).toBeVisible();
    await expect(row).toBeHidden();
    await member.reload();
    await member.waitForURL(/\/login/);

    // The trail names who signed up, and who ended the session.
    await page.getByRole("tab", { name: "Audit log" }).click();
    await page.getByRole("radio", { name: "Sign-ins" }).click();
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
    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByLabel("Search accounts").fill(memberEmail);
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

    // A name and an address corrected. An address another account has is
    // refused, and the dialog keeps what was typed.
    await page
      .getByRole("button", { name: `Actions for Member ${stamp}` })
      .click();
    await page.getByRole("menuitem", { name: "Edit name and email" }).click();
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
    await page.getByLabel("Search accounts").fill(movedEmail);
    await expect(
      page.getByRole("row", { name: new RegExp(movedEmail) }),
    ).toContainText(`Renamed ${stamp}`);
    // Their own name too, which the page shows at once.
    await page.getByLabel("Search accounts").fill(email);
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
    await page.getByRole("tab", { name: "Audit log" }).click();
    await page.getByRole("radio", { name: "Sign-ins" }).click();
    await expect(
      page
        .getByRole("row", { name: new RegExp(`Renamed ${stamp}`) })
        .filter({ hasText: "Account changed" })
        .first(),
    ).toContainText(`Ada ${stamp}`);

    await page.getByRole("tab", { name: "Support" }).click();
    // Operator notices need SMTP (ADR 0052); without it the form stays shut.
    await expect(
      page.getByRole("heading", { name: "Message accounts" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Set up email under Integrations before you can send a notice.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send notice" }),
    ).toBeDisabled();
    expect(await accessibilityViolations(page)).toEqual([]);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export who has access" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^anygriddb-access-.*\.csv$/);
    const csv = await readFile((await file.path()) ?? "", "utf8");
    expect(csv).toContain(movedEmail);
    expect(csv).toContain(email);

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
    await page.getByRole("tab", { name: "Health" }).click();
    await expect(
      page
        .locator("dt", { hasText: /^Version$/ })
        .locator("xpath=following-sibling::dd[1]"),
    ).toHaveText(`${version} · from sources`);

    await other.close();
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});

// A departure (ADR 0051): the account is disabled, then erased. It alone
// owns a base, so the administrator names the colleague who takes it.
test("an administrator erases a departed owner and names who takes the base", async ({
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
    await heir.goto("/signup");
    await heir.getByLabel("Email").fill(heirEmail);
    await heir.getByLabel("Display name").fill(`Heir ${stamp}`);
    await heir.getByLabel("Password").fill("correct-horse-battery");
    await heir.getByRole("button", { name: "Create account" }).click();
    await heir.waitForURL(/\/welcome/);

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByLabel("Search accounts").fill(leavingEmail);
    const row = page.getByRole("row", { name: new RegExp(leavingEmail) });
    // Erase is offered on a disabled account only.
    await expect(row.getByRole("button", { name: "Erase…" })).toHaveCount(0);
    await row.getByRole("button", { name: "Disable" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();

    await row.getByRole("button", { name: "Erase…" }).click();
    await expect(dialog).toContainText("No one else owns these bases: Lab.");
    expect(await accessibilityViolations(page)).toEqual([]);

    // Nothing typed, then no new owner, then an address no account has:
    // each is refused and the dialog stays.
    const erase = dialog.getByRole("button", { name: "Erase", exact: true });
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
    await page.getByRole("tab", { name: "Audit log" }).click();
    await page.getByRole("radio", { name: "Sign-ins" }).click();
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
