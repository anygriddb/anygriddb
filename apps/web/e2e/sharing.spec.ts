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
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.60" } });

// A role given to an address: the owner is told the same thing whether or
// not the address has an account, and the person who has one finds the
// invitation on their home page and accepts it there, without a link.
test("an owner invites an address, and its account accepts from its home page", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);

  await signUpWithTable(page, "Olive Owner");
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
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  // Not "Access granted": nothing says the address has an account.
  await expect(page.getByText(/^Invitation (emailed|created)$/)).toBeVisible();
  await expect(page.getByText(guestEmail)).toBeVisible();

  await guest.goto("/");
  const invitations = guest.getByRole("region", { name: "Invitations" });
  await expect(
    invitations.getByText("Olive Owner invites you to Lab as Editor"),
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

  await own.close();
  expect(blocked).toEqual([]);
});
