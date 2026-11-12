import { expect, test } from "@playwright/test";
import {
  enableTotp,
  nextTotp,
  signIn,
  signUp,
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
