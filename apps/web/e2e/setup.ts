import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { decodeBase32, totpCode } from "../../api/src/auth/totp-code.ts";

/**
 * The journeys' PostgreSQL as the cluster's own first role. A journey
 * that plays a client's administrator (a role and a database of the
 * client's) signs in as it: AnyGridDB's role may create neither role nor
 * anything in a database it does not own (ADR 0003).
 */
export function clusterUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL ??
      "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb",
  );
  url.username = "postgres";
  return url.toString();
}

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
 * Collects what the page fails on with nobody to catch it: an exception
 * thrown, a promise refused. A refusal the page tells the person is no
 * such failure: a journey that meets some ends with this list empty.
 */
export function watchFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(`${error.name}: ${error.message}`);
  });
  return failures;
}

/** A unique part for a journey's names: time, then random bytes. */
export function uniqueStamp(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** The mail catcher of `scripts/e2e.sh` (docker/compose.e2e.yml). */
const MAIL_API = process.env.MAIL_API ?? "http://127.0.0.1:8026/api/v1";

/**
 * The path of the newest link of this app of the given kind mailed to
 * `to`, waiting for the mail to arrive.
 */
export async function mailedLink(
  to: string,
  kind: "signup" | "reset",
): Promise<string> {
  const link = new RegExp(`/${kind}/[A-Za-z0-9_-]{43}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const search = await fetch(
      `${MAIL_API}/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: Array<{ ID: string }>;
    };
    // Newest first.
    for (const message of messages) {
      const read = await fetch(`${MAIL_API}/message/${message.ID}`);
      const { Text } = (await read.json()) as { Text: string };
      const found = link.exec(Text)?.[0];
      if (found) return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no ${kind} link mailed to ${to}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The newest mail to `to` whose subject holds `subject`, waiting for it to
 * arrive: who it says it is from, its subject, and its text.
 */
export async function mailedMessage(
  to: string,
  subject: string,
): Promise<{ fromName: string; subject: string; text: string }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const search = await fetch(
      `${MAIL_API}/search?query=${encodeURIComponent(`to:"${to}" subject:"${subject}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: Array<{ ID: string }>;
    };
    const newest = messages[0];
    if (newest) {
      const read = await fetch(`${MAIL_API}/message/${newest.ID}`);
      const message = (await read.json()) as {
        From: { Name: string };
        Subject: string;
        Text: string;
      };
      return {
        fromName: message.From.Name,
        subject: message.Subject,
        text: message.Text,
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`no mail "${subject}" to ${to}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The six-digit code of the newest mail to `to` whose subject holds
 * `subject`, alone on its line.
 */
export async function mailedCode(to: string, subject: string): Promise<string> {
  const { text } = await mailedMessage(to, subject);
  const code = /^(\d{6})$/m.exec(text.replace(/\r/g, ""))?.[1];
  if (!code) throw new Error(`no code in the mail "${subject}" to ${to}`);
  return code;
}

/**
 * The journeys meet the grid as a person who has hidden its tips, on every
 * page of their browser; the first journey shows them (`gridTips`).
 */
async function hideGridTips(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    // A page that has not gone anywhere yet has no storage to read.
    if (window.origin === "null") return;
    window.localStorage.setItem("ag_grid_tips", "hidden");
  });
}

/**
 * A new account, made as a person makes one, on the first-run page. Past
 * the instance's first account, the sign-up mails a link to the address,
 * opened here with the same password (ADR 0058).
 */
export async function signUp(
  page: Page,
  input: { email: string; name: string; password: string },
  options: { gridTips?: boolean } = {},
): Promise<void> {
  if (!options.gridTips) await hideGridTips(page);
  await page.goto("/signup");
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Display name").fill(input.name);
  await page.getByLabel("Password").fill(input.password);
  await page.getByRole("button", { name: "Create an account" }).click();
  const outcome = await Promise.race([
    page.waitForURL(/\/welcome/).then(
      () => "session" as const,
      () => null,
    ),
    page
      .getByRole("heading", { name: "Check your email" })
      .waitFor()
      .then(
        () => "mailed" as const,
        () => null,
      ),
  ]);
  if (outcome === "session") return;
  if (outcome === null) throw new Error(`sign-up of ${input.email} stalled`);
  await page.goto(await mailedLink(input.email, "signup"));
  await page.getByLabel("Password").fill(input.password);
  await page.getByRole("button", { name: "Create my account" }).click();
  await page.waitForURL(/\/welcome/);
}

/** Signs in with a password, from the sign-in page. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await hideGridTips(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Sets up an authenticator for the signed-in account, on a page that
 * offers it (the welcome page, the account page), and returns its secret.
 */
export async function enableTotp(page: Page): Promise<string> {
  await page
    .getByRole("button", { name: "Set up an authenticator app" })
    .click();
  await page
    .getByRole("img", { name: "Code to scan with your authenticator app" })
    .waitFor();
  const secret = await page.getByLabel("Setup key").inputValue();
  await page
    .getByLabel("Code shown by the app")
    .fill(totpCode(decodeBase32(secret), Date.now()));
  await page.getByRole("button", { name: "Confirm the code" }).click();
  await page.getByRole("button", { name: "I saved the codes" }).click();
  return secret;
}

/** A code of the next step: the one that enrolled is spent. */
export function nextTotp(secret: string): string {
  return totpCode(decodeBase32(secret), Date.now() + 30_000);
}

/**
 * A new account with a second factor, a base, and a table, open on its
 * grid. Each journey gets its own account, so journeys run side by side.
 */
export async function signUpWithTable(
  page: Page,
  name: string,
  options: { gridTips?: boolean } = {},
): Promise<{ email: string }> {
  const stamp = uniqueStamp();
  const email = `e2e-${stamp}@example.com`;
  await signUp(
    page,
    { email, name, password: "correct-horse-battery" },
    options,
  );

  await enableTotp(page);

  // A modal leaves the page behind it inert: actions are looked up in it.
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "New base" }).first().click();
  await dialog.getByLabel("Base name").fill("Lab");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Add a table" }).click();
  await dialog.getByLabel("Table name").fill("Samples");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("grid").waitFor();
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
        .map(
          (node) =>
            `${node.target.join(" ")} ${node.html.replace(/\s+/g, " ").slice(0, 160)}`,
        )
        .join(", ")}`,
  );
}

/**
 * Opens a page of Administration through its own navigation (ROADMAP
 * #49): a section, then one of its pages when it has several.
 */
export async function openAdmin(
  page: Page,
  section: string,
  subpage?: string,
): Promise<void> {
  await page
    .getByRole("navigation", { name: "Administration" })
    .getByRole("link", { name: section, exact: true })
    .click();
  if (subpage) {
    await page
      .getByRole("navigation", { name: section })
      .getByRole("link", { name: subpage, exact: true })
      .click();
  }
}

/**
 * Finds one account in Administration's list by its address: the list
 * follows the search box a moment after typing stops.
 */
export async function findAccount(page: Page, email: string): Promise<void> {
  await page.getByLabel("Search accounts").fill(email);
  await expect(page.getByText("1 account", { exact: true })).toBeVisible();
}

/**
 * Picks a field's type in the field dialog: its "Type" button opens the
 * list of types, where one is chosen by its name.
 */
export async function pickFieldType(
  page: Page,
  dialog: Locator,
  type: string,
): Promise<void> {
  await dialog.getByLabel("Type", { exact: true }).click();
  // An option is read with its description: it is found by its name.
  await page
    .getByRole("option")
    .filter({ has: page.getByText(type, { exact: true }) })
    .click();
}

/**
 * Gives the password a sensitive Administration action asks for again
 * (ROADMAP #28). Once given, the next five minutes ask nothing.
 */
export async function proveItIsYou(
  page: Page,
  password = "correct-horse-battery",
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Password").fill(password);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
}
