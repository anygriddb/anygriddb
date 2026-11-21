import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { uniqueStamp } from "./setup";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The token, asked for as the operator does: `anygriddb install-token`. */
function installToken(): string {
  const printed = execFileSync(
    "pnpm",
    ["--silent", "--filter", "@anygriddb/api", "cli", "install-token"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgres://anygriddb:anygriddb@127.0.0.1:5433/anygriddb",
      },
    },
  );
  return printed.split("\n")[0]?.trim() ?? "";
}

// An instance's first account administers it, and is made with a token
// its operator asks for where the instance runs (ADR 0080). It is made
// here, once, before the journeys: each of them then signs up as anyone
// does on an instance that is set up, by a link mailed to its address.
// It signs up twice, so it takes a client address of its own: sign-ups
// are counted per address, and the journeys share theirs.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.5" } });

test("the first account takes the operator's token", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").waitFor();
  const token = page.getByLabel("Install token");
  // A database kept from an earlier run has its first account already.
  test.skip(!(await token.isVisible()), "the instance has an account");

  const stamp = uniqueStamp();
  await page.getByLabel("Email").fill(`e2e-first-${stamp}@example.com`);
  await page.getByLabel("Display name").fill("First Operator");
  await page.getByLabel("Password").fill("correct-horse-battery");

  // A guess is refused, and no account is made.
  await token.fill("a-guess-at-the-token");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/This install token is wrong/)).toBeVisible();

  // The first account administers the instance, and the policy asks an
  // administrator for a second factor before anything else. Until it is
  // there the server refuses every list the pages share: the page asks
  // for none of them, where it was refused four at once.
  const asked: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/trpc/")) asked.push(path);
  });
  await token.fill(installToken());
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/welcome/);
  await expect(
    page.getByRole("button", { name: "Set up an authenticator app" }),
  ).toBeVisible();
  // The page is drawn: what it asks on arriving leaves within a turn.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => setTimeout(resolve, 0), 0);
      }),
  );
  expect(
    asked.filter((path) =>
      /\b(catalog|jobs|notifications|shortcuts)\.list\b/.test(path),
    ),
  ).toEqual([]);

  // The form asks nobody else for it.
  await page.context().clearCookies();
  await page.goto("/signup");
  await page.getByLabel("Email").waitFor();
  await expect(page.getByLabel("Install token")).toBeHidden();
});
