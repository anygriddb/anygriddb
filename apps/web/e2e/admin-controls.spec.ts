import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { signUpWithTable, uniqueStamp, watchPolicy } from "./setup";

const controlUrl =
  process.env.DATABASE_URL ??
  "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb";

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
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
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

    await page.getByRole("tab", { name: "Support" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export who has access" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^anygriddb-access-.*\.csv$/);
    const csv = await readFile((await file.path()) ?? "", "utf8");
    expect(csv).toContain(memberEmail);
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
