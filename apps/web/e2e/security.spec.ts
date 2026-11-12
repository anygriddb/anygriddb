import { expect, test } from "@playwright/test";
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
 * the sign-in rate limit the other journeys spent is not this one's, and
 * the guesses come from elsewhere than the account's owner.
 */
const from = (address: string) => ({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { "x-forwarded-for": address },
});
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } });

// The security policy (ADR 0043): an administrator sets the lock, the
// account locks after failed passwords, the administrator unlocks it and
// sends a reset link, which goes to the person's own address, and the
// person sets a new password, then changes it. It changes instance
// settings: after the other journeys, before maintenance.
test("an administrator sets the lock, unlocks an account, and sends a reset link", async ({
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

    await page.goto("/admin/security");
    await page.getByLabel("Lock an account after").selectOption("3");
    await expect(page.getByText("Settings saved")).toBeVisible();

    // Someone signs up in their own browser.
    const own = await browser.newContext(from("198.51.100.20"));
    const member = await own.newPage();
    const stamp = uniqueStamp();
    const memberEmail = `e2e-locked-${stamp}@example.com`;
    const name = `Locked ${stamp}`;
    await signUp(member, {
      email: memberEmail,
      name: name,
      password: "correct-horse-battery",
    });

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
    // It opens the locked accounts, the filter kept in the address.
    await page.waitForURL(/\/admin\/people\/accounts\?status=locked$/);
    await expect(page.getByLabel("Status")).toHaveValue("locked");
    await findAccount(page, memberEmail);
    const row = page.getByRole("row", { name: new RegExp(memberEmail) });
    await expect(row).toContainText("Locked until");
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Unlock" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Unlock" })
      .click();
    await expect(page.getByText("Unlocked")).toBeVisible();
    // No longer locked, so no longer in the list of the locked.
    await expect(row).toBeHidden();
    await page.getByLabel("Status").selectOption("");
    await expect(row).not.toContainText("Locked until");

    // A reset link: with email set up, it goes to the person's own
    // address, and the administrator never sees it.
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page
      .getByRole("menuitem", { name: "Send a password reset link" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect(page.getByText(`Link sent to ${memberEmail}`)).toBeVisible();

    await guess.goto(await mailedLink(memberEmail, "reset"));
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
    await openAdmin(page, "Security");
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
    await openAdmin(page, "Trails", "Sign-ins");
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

// In an emergency (ROADMAP #24): every API token revoked at once, and
// every public link turned off, from one place. It changes instance
// settings: after the other journeys, before maintenance.
test("an administrator revokes every token and turns public links off", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Emergency Admin");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);
    const made = await page.evaluate(async () => {
      const answer = await fetch("/trpc/auth.createToken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "script" }),
      });
      return ((await answer.json()) as { result: { data: { token: string } } })
        .result.data.token;
    });
    const asScript = () =>
      page.evaluate(
        async (token) =>
          (
            await fetch("/api/v1/bases", {
              // The token alone, without the page's session.
              credentials: "omit",
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        made,
      );
    expect(await asScript()).toBe(200);

    await page.goto("/admin/security");
    await expect(
      page.getByRole("heading", { name: "In an emergency" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Revoke every API token" }).click();
    await page
      .getByRole("dialog", { name: "Revoke every API token?" })
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await expect(page.getByText(/API tokens? revoked/)).toBeVisible();
    expect(await asScript()).toBe(401);

    const linksOff = page.getByRole("button", {
      name: "Turn public links off",
    });
    await linksOff.click();
    await page
      .getByRole("dialog", { name: "Turn public links off?" })
      .getByRole("button", { name: "Turn off", exact: true })
      .click();
    await expect(page.getByText("Public links are off").first()).toBeVisible();
    await expect(linksOff).toBeDisabled();
    await expect(
      page.getByLabel("Public links to views and forms"),
    ).toHaveValue("off");
    expect(await accessibilityViolations(page)).toEqual([]);

    // The trail says who did it, for each account that had a token.
    await openAdmin(page, "Trails", "Sign-ins");
    await expect(
      page
        .getByRole("row", { name: /API tokens revoked/ })
        .filter({ hasText: "Every token of the instance" })
        .first(),
    ).toContainText("Emergency Admin");

    // Back to the default for the journeys after this one.
    await openAdmin(page, "Security");
    await page
      .getByLabel("Public links to views and forms")
      .selectOption("allowed");
    await expect(linksOff).toBeEnabled();
    expect(blocked).toEqual([]);
  } finally {
    const left = await control.query(
      "delete from instance_settings where key = 'publicLinks' and value <> '\"allowed\"' returning key",
    );
    if (left.rowCount) await new Promise((done) => setTimeout(done, 6_000));
    await control.end();
  }
});
