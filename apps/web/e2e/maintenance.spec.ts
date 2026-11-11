import { expect, test } from "@playwright/test";
import pg from "pg";
import { signUp, signUpWithTable, uniqueStamp, watchPolicy } from "./setup";

const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

// Maintenance signs everyone but administrators out (ADR 0042): this
// journey runs alone, after the others (the "maintenance" project).
test("maintenance keeps everyone but administrators out, and an announcement shows", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Admin Maintenance");
    await control.query("update users set is_admin = true where email = $1", [
      email,
    ]);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    const member = await other.newPage();
    const stamp = uniqueStamp();
    const memberEmail = `e2e-out-${stamp}@example.com`;
    await signUp(member, {
      email: memberEmail,
      name: `Out ${stamp}`,
      password: "correct-horse-battery",
    });

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Settings" }).click();
    // The confirmation dialog is named after maintenance too.
    const maintenance = page.getByRole("checkbox", { name: /Maintenance/ });
    // The box changes once the dialog is confirmed.
    await maintenance.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Turn on" })
      .click();
    await expect(maintenance).toBeChecked();
    await page
      .getByLabel("Announcement")
      .fill("Upgrade in progress, back at 18:00.");
    await page.getByRole("button", { name: "Publish" }).click();
    const banner = page
      .getByRole("status")
      .filter({ hasText: "Upgrade in progress, back at 18:00." });
    await expect(banner).toContainText("only administrators can sign in");

    // The member was signed out, and the sign-in page says why.
    await member.reload();
    await member.waitForURL(/\/login/);
    await expect(member.getByRole("status")).toContainText(
      "The instance is under maintenance",
    );
    await expect(member.getByRole("status")).toContainText(
      "Upgrade in progress, back at 18:00.",
    );
    await member.getByLabel("Email").fill(memberEmail);
    await member.getByLabel("Password").fill("correct-horse-battery");
    await member.getByRole("button", { name: "Sign in" }).click();
    await expect(
      member.getByText("The instance is under maintenance. Try again later."),
    ).toBeVisible();

    await maintenance.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Turn off" })
      .click();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(banner).toBeHidden();

    await member.getByRole("button", { name: "Sign in" }).click();
    await member.waitForURL((url) => !url.pathname.startsWith("/login"));

    await other.close();
    expect(blocked).toEqual([]);
  } finally {
    // A failed run must not leave the shared instance in maintenance: the
    // next run's journeys could not sign up.
    await control.query(
      "delete from instance_settings where key in ('maintenance', 'banner')",
    );
    await control.end();
  }
});
