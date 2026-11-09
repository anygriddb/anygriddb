import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signUpWithTable, watchPolicy } from "./setup";

const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

/**
 * Addresses of their own (the API trusts its first proxy): the sign-in
 * rate limit the other journeys spent on 127.0.0.1 is not this one's, and
 * the guesses come from elsewhere than the account's owner.
 */
const from = (address: string) => ({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { "x-forwarded-for": address },
});
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } });

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The security policy (ADR 0043): an administrator sets the lock, the
// account locks after failed passwords, the administrator unlocks it and
// sends a reset link (the test server has no email, so the link is handed
// over), and the person sets a new password, then changes it. It changes
// instance settings: after the other journeys, before maintenance.
test("an administrator sets the lock, unlocks an account, and hands over a reset link", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Security Admin");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Security" }).click();
    await page.getByLabel("Lock an account after").selectOption("3");
    await expect(page.getByText("Settings saved")).toBeVisible();

    // Someone signs up in their own browser.
    const own = await browser.newContext(from("198.51.100.20"));
    const member = await own.newPage();
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const memberEmail = `e2e-locked-${stamp}@example.com`;
    const name = `Locked ${stamp}`;
    await member.goto("/signup");
    await member.getByLabel("Email").fill(memberEmail);
    await member.getByLabel("Display name").fill(name);
    await member.getByLabel("Password").fill("correct-horse-battery");
    await member.getByRole("button", { name: "Create account" }).click();
    await member.waitForURL(/\/welcome/);

    // Another browser guesses the password three times.
    const elsewhere = await browser.newContext(from("203.0.113.66"));
    const guess = await elsewhere.newPage();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await signIn(guess, memberEmail, `not-the-password-${String(attempt)}`);
      await expect(guess.getByRole("alert")).toHaveText(
        "Invalid email or password",
      );
    }
    // Locked: even the right password is refused.
    await signIn(guess, memberEmail, "correct-horse-battery");
    await expect(guess.getByRole("alert")).toContainText(
      "This account is locked",
    );

    // The administrator hears of it in the app (ADR 0044).
    await page.reload();
    await page
      .getByRole("button", { name: /^Notifications \(\d+ unread\)$/ })
      .click();
    await page
      .getByRole("button", {
        name: new RegExp(`^${name}'s account locked after failed sign-ins`),
      })
      .click();
    await page.waitForURL(/\/admin$/);

    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByLabel("Search accounts").fill(memberEmail);
    const row = page.getByRole("row", { name: new RegExp(memberEmail) });
    await expect(row).toContainText("Locked until");
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Unlock" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Unlock" })
      .click();
    await expect(page.getByText("Done")).toBeVisible();
    await expect(row).not.toContainText("Locked until");

    // A reset link, handed over since the server sends no email.
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page
      .getByRole("menuitem", { name: "Send a password reset link" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Send" })
      .click();
    const handed = page.getByRole("dialog", { name: `Reset link for ${name}` });
    const link = (await handed.locator("code").textContent()) ?? "";
    expect(link).toMatch(/\/reset\/[A-Za-z0-9_-]{43}$/);
    await handed.getByRole("button", { name: "Cancel" }).click();

    await guess.goto(new URL(link).pathname);
    await guess
      .getByLabel("New password", { exact: true })
      .fill("a-new-long-passphrase");
    await guess.getByLabel("New password, again").fill("a-new-long-passphrase");
    await guess.getByRole("button", { name: "Set the password" }).click();
    await expect(guess.getByText("Your password is changed")).toBeVisible();
    // The link is spent.
    await guess.reload();
    await expect(guess.getByRole("alert")).toContainText(
      "This link no longer works",
    );
    // Every session of the account ended, the first browser's too.
    await member.reload();
    await member.waitForURL(/\/login/);

    await signIn(member, memberEmail, "a-new-long-passphrase");
    await member.waitForURL((url) => !url.pathname.startsWith("/login"));
    await member.goto("/settings");
    await member.getByLabel("Current password").fill("a-new-long-passphrase");
    await member
      .getByLabel("New password", { exact: true })
      .fill("another-long-passphrase");
    await member
      .getByLabel("New password, again")
      .fill("another-long-passphrase");
    await member.getByRole("button", { name: "Change the password" }).click();
    await expect(
      member.getByText("Password changed. Your other sessions ended."),
    ).toBeVisible();

    // Only administrators create bases: the member is told, not offered.
    await page.getByRole("tab", { name: "Security" }).click();
    await page.getByLabel("Who can create bases").selectOption("admins");
    await expect(page.getByText("Settings saved").first()).toBeVisible();
    await member.goto("/");
    await expect(
      member.getByText("On this instance, administrators create the bases"),
    ).toBeVisible();
    await expect(member.getByRole("button", { name: "New base" })).toHaveCount(
      0,
    );
    // Back to the defaults through the API's own path, which clears its
    // settings cache at once: the next journeys create bases.
    await page.getByLabel("Who can create bases").selectOption("everyone");
    await page.getByLabel("Lock an account after").selectOption("10");
    await expect(page.getByLabel("Lock an account after")).toHaveValue("10");
    await expect(page.getByLabel("Who can create bases")).toHaveValue(
      "everyone",
    );

    // The trail keeps the lock, the unlock, the link, and the reset.
    await page.getByRole("tab", { name: "Audit log" }).click();
    await page.getByRole("radio", { name: "Sign-ins" }).click();
    const theirs = page.getByRole("row", { name: new RegExp(name) });
    await expect(
      theirs.filter({ hasText: "Account locked" }).first(),
    ).toBeVisible();
    await expect(theirs.filter({ hasText: "Account unlocked" })).toContainText(
      "Security Admin",
    );
    await expect(
      theirs.filter({ hasText: "Link from an administrator" }),
    ).toBeVisible();
    await expect(theirs.filter({ hasText: "Password changed" })).toBeVisible();
    await expect(
      page
        .getByRole("row", { name: /Setting changed/ })
        .filter({ hasText: "Failed attempts before locking" })
        .first(),
    ).toContainText("Security Admin");

    await own.close();
    await elsewhere.close();
    expect(blocked).toEqual([]);
  } finally {
    // After a failure: the settings go, and the API's five-second cache
    // with them, before the next journeys start.
    const left = await control.query(
      "delete from instance_settings where key in ('lockoutThreshold', 'baseCreation') and value not in ('10', '\"everyone\"') returning key",
    );
    if (left.rowCount) await new Promise((done) => setTimeout(done, 6_000));
    await control.end();
  }
});
