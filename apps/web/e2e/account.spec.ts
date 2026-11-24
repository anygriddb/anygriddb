import { expect, test } from "./journey";
import {
  accessibilityViolations,
  enableTotp,
  mailedCode,
  nextTotp,
  signIn,
  signUp,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

// It makes an account: an address of its own, as sign-ups are counted per
// client address and the other journeys share theirs.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.70" } });

// Deleting one's own account asks what a sensitive action asks: the
// password, and a code from the authenticator when the account has one.
test("a person deletes their own account with their password and a code", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const stamp = uniqueStamp();
  const email = `e2e-leaving-${stamp}@example.com`;
  const password = "correct-horse-battery";
  await signUp(page, { email, name: `Leaving ${stamp}`, password });

  await page.goto("/settings");
  const secret = await enableTotp(page);

  // The password alone is no longer enough.
  const remove = page.getByRole("button", { name: "Delete", exact: true });
  await page
    .getByRole("textbox", { name: "Password", exact: true })
    .fill(password);
  await expect(remove).toBeDisabled();
  // A code is used once: the one that enrolled is spent, the next step's is not.
  await page
    .getByLabel("Code from your authenticator app, or a backup code")
    .fill(nextTotp(secret));
  await remove.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page.waitForURL(/\/login/);

  // The account is gone: its address and password open nothing.
  await signIn(page, email, password);
  await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
  expect(blocked).toEqual([]);
});

// A code by email as a second factor (ADR 0085): a member chooses it from
// their account, proves their mailbox with a first code, saves the backup
// codes, then signs in with a code that nothing sends until they ask.
test("a member chooses a code by email, and signs in with one", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const stamp = uniqueStamp();
  const email = `e2e-mailcode-${stamp}@example.com`;
  const password = "correct-horse-battery";
  await signUp(page, { email, name: `Mailcode ${stamp}`, password });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up a code by email" }).click();
  await expect(
    page.getByText("A code was sent to your address. It works once"),
  ).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  const code = await mailedCode(email, "confirmation code");
  // A wrong code is refused, and the right one still works after it.
  const field = page.getByLabel("Code received by email");
  await field.fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Confirm the code" }).click();
  await expect(
    page.getByText("This code is wrong, or works no longer"),
  ).toBeVisible();
  await field.fill(code);
  await page.getByRole("button", { name: "Confirm the code" }).click();
  // A first factor: the account is given its backup codes.
  await page.getByRole("button", { name: "I saved the codes" }).click();
  await expect(page.getByText("A code by email is set up.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Turn off the code by email" }),
  ).toBeVisible();

  // Another browser session: the password, then the second step. No code
  // leaves, and no field asks for one, until the person asks.
  await page.context().clearCookies();
  await signIn(page, email, password);
  await expect(
    page.getByRole("heading", { name: "Second factor" }),
  ).toBeVisible();
  await expect(page.getByLabel("Code received by email")).toHaveCount(0);
  await page.getByRole("button", { name: "Send a code to my address" }).click();
  await expect(page.getByLabel("Code received by email")).toBeVisible();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page
    .getByLabel("Code received by email")
    .fill(await mailedCode(email, "sign-in code"));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  // In: the account's own page opens.
  await page.goto("/settings");
  await expect(page.getByText("A code by email is set up.")).toBeVisible();
  expect(blocked).toEqual([]);
});

// A token of one's own: made, shown once, listed with the day it ends,
// and revoked once that is confirmed. Whatever uses it stops then, and a
// token is not made again: one click did it.
test("an API token is made, listed with the day it ends, and revoked once confirmed", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Token Maker");
  await page.goto("/settings");
  await page.getByLabel("Token name").fill("Nightly");
  await page.getByLabel("Days").fill("7");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const token = page.getByRole("listitem").filter({ hasText: "Nightly" });
  // A day, as every screen writes one: not the first ten characters of
  // an instant.
  await expect(token).toContainText(/expires on \d{2}\/\d{2}\/\d{4}/);
  await expect(token).toContainText("never used");
  expect(await accessibilityViolations(page)).toEqual([]);

  await token.getByRole("button", { name: "Revoke" }).click();
  const asking = page.getByRole("dialog", { name: "Revoke Nightly?" });
  await expect(asking).toContainText("is refused from now on");
  expect(await accessibilityViolations(page)).toEqual([]);
  await asking.getByRole("button", { name: "Cancel" }).click();
  await expect(token).toBeVisible();
  await token.getByRole("button", { name: "Revoke" }).click();
  await asking.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(token).toHaveCount(0);
  expect(blocked).toEqual([]);
});

// Each kind of notice goes where the person says (ADR 0123); a base or a
// table can be muted from the base's settings, and unmuted from either
// page; a security notice keeps its email; a link from no mail does nothing.
test("a person chooses where each notice goes, and mutes a base", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  await signUpWithTable(page, "Notice Chooser");
  const baseId = /\/b\/([^/]+)/.exec(page.url())?.[1] ?? "";

  await page.goto("/settings");
  const digest = page.getByLabel("Mention in a comment — Daily digest");
  await expect(digest).not.toBeChecked();
  // Shown once the server has kept it.
  await digest.click();
  await expect(digest).toBeChecked();
  const required = page.getByLabel("Your password changed — Email now");
  await expect(required).toBeChecked();
  await expect(required).toBeDisabled();
  expect(await accessibilityViolations(page)).toEqual([]);
  await page.reload();
  await expect(
    page.getByLabel("Mention in a comment — Daily digest"),
  ).toBeChecked();

  await page.goto(`/b/${baseId}/settings`);
  await page.getByRole("button", { name: "Mute this base" }).click();
  await expect(
    page.getByRole("button", { name: "Unmute this base" }),
  ).toBeVisible();
  await page.goto("/settings");
  const muted = page.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Remove" }),
  });
  await expect(muted).toHaveCount(1);
  await muted.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByText(
      "Nothing muted. A base's settings mute it, or one of its tables.",
    ),
  ).toBeVisible();

  await page.goto(`/notify/unsubscribe/${"a".repeat(30)}~${"b".repeat(43)}`);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("alert")).toHaveText("This link is not valid.");
  expect(blocked).toEqual([]);
});
