import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { decodeBase32, totpCode } from "../../api/src/auth/totp-code.ts";

/**
 * Collects what the page's security policy blocks. The app is served under
 * `script-src 'self'` and `connect-src 'self'`: a journey ends with this
 * list empty.
 */
export function watchPolicy(page: Page): string[] {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy"))
      blocked.push(message.text());
  });
  return blocked;
}

/**
 * A new account with a second factor, a base, and a table, open on its
 * grid. Each journey gets its own account, so journeys run side by side.
 */
export async function signUpWithTable(
  page: Page,
  name: string,
): Promise<{ email: string }> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `e2e-${stamp}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/welcome/);

  await page.getByRole("button", { name: "Enable TOTP" }).click();
  const secret = await page.getByLabel("Secret").inputValue();
  await page
    .getByLabel("Code", { exact: true })
    .fill(totpCode(decodeBase32(secret), Date.now()));
  await page.getByRole("button", { name: "Confirm TOTP" }).click();
  await page.getByRole("button", { name: "I saved the codes" }).click();

  // A modal leaves the page behind it inert: actions are looked up in it.
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "New base" }).first().click();
  await dialog.getByLabel("Base name").fill("Lab");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Add a table" }).click();
  await dialog.getByLabel("Table name").fill("Samples");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("grid").waitFor();
  // The realtime socket connected on the page's own origin.
  await expect(page.getByText("Live")).toBeVisible();
  return { email };
}

/**
 * Checks the page against WCAG 2.2 A and AA with axe: a journey asserts
 * the list of violations is empty, each named with the nodes it found.
 */
export async function accessibilityViolations(page: Page): Promise<string[]> {
  // A fading toast or an opening popover is measured once it has settled.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-sonner-toast]")].every(
      (toast) => getComputedStyle(toast).opacity === "1",
    ),
  );
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getTiming().iterations !==
            Number.POSITIVE_INFINITY,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}
