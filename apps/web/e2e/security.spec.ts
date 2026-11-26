import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { journeysDatabaseUrl } from "./database-url";
import { expect, test } from "./journey";
import pg from "pg";
import {
  accessibilityViolations,
  enableTotp,
  findAccount,
  mailedLink,
  mailedMessage,
  MAKE_ADMINISTRATOR,
  nextTotp,
  openAdmin,
  proveItIsYou,
  signIn,
  signUp,
  signUpWithTable,
  uniqueStamp,
  watchPolicy,
} from "./setup";

const controlUrl = journeysDatabaseUrl();

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

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** `anygriddb admin recover`, run as the operator does, where the instance runs. */
function recover(...args: string[]) {
  return spawnSync(
    "pnpm",
    [
      "--silent",
      "--filter",
      "@anygriddb/api",
      "cli",
      "admin",
      "recover",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: controlUrl,
        PUBLIC_URL: process.env.PUBLIC_URL ?? "https://localhost:4010",
      },
    },
  );
}

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
    await control.query(MAKE_ADMINISTRATOR, [email]);

    await page.goto("/admin/security");
    await page.getByLabel("Lock an account after").selectOption("3");
    // A change made in Administration asks for the proof (ADR 0073).
    await proveItIsYou(page);
    await expect(page.getByText("Settings saved")).toBeVisible();

    // The change trail's copy is turned on before any collector is named,
    // and says what it waits for (ADR 0120).
    await page.getByLabel("Send to the collectors").selectOption("on");
    await expect(
      page.getByText(
        "No collector is set: changes wait until one is, in Connections.",
      ),
    ).toBeVisible();

    // A list of sign-in addresses that leaves out the one it is saved
    // from is refused: it would refuse this administrator's next sign-in.
    await page.getByLabel("Allowed CIDR ranges").fill("192.0.2.0/24");
    await page.getByRole("button", { name: "Save allowlist" }).click();
    await expect(
      page.getByText(
        /This list leaves out the address you are saving it from.*198\.51\.100\.10/,
      ),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Allowed CIDR ranges")).toHaveValue("");

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
      .getByRole("button", { name: /^Notifications, \d+ unread$/ })
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

    // Sign-up closed: the pages say so before anything is typed, and
    // nothing offers an account that cannot be made.
    await openAdmin(page, "Instance");
    await page.getByLabel("Sign-ups").selectOption("closed");
    await expect(page.getByText("Settings saved").first()).toBeVisible();
    const visitor = await (
      await browser.newContext(from("198.51.100.30"))
    ).newPage();
    await visitor.goto("/signup");
    await expect(
      visitor.getByText("Sign-up is closed on this instance"),
    ).toBeVisible();
    await expect(
      visitor.getByRole("button", { name: "Create an account" }),
    ).toHaveCount(0);
    expect(await accessibilityViolations(visitor)).toEqual([]);
    await visitor.goto("/login");
    await expect(
      visitor.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      visitor.getByRole("link", { name: "No account yet? Create one" }),
    ).toHaveCount(0);
    await page.getByLabel("Sign-ups").selectOption("open");
    await expect(page.getByLabel("Sign-ups")).toHaveValue("open");
    await visitor.reload();
    await expect(
      visitor.getByRole("link", { name: "No account yet? Create one" }),
    ).toBeVisible();

    // A page asked for signed out is the one opened once signed in.
    await visitor.goto("/settings?from=mail");
    await visitor.waitForURL(/\/login\?next=%2Fsettings%3Ffrom%3Dmail$/);
    await visitor.getByLabel("Email").fill(memberEmail);
    await visitor.getByLabel("Password").fill("another-long-passphrase");
    await visitor.getByRole("button", { name: "Sign in", exact: true }).click();
    await visitor.waitForURL(/\/settings\?from=mail$/);

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
    await control.query(MAKE_ADMINISTRATOR, [email]);
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
    // Asked again before it goes: the administrator's password.
    await proveItIsYou(page);
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

// Map tiles (ADR 0068): none is asked of anyone until an administrator
// names a tile server; then maps draw their background from it, with the
// credit it asks for, and the page's policy lets those images in and no
// other. It changes an instance setting, and puts it back.
test("an administrator names a tile server, and maps draw their background from it", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  // A tile server answered here: one pixel for every tile asked.
  const asked: string[] = [];
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route("https://tiles.example.org/**", (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "image/png", body: pixel });
  });
  try {
    const { email } = await signUpWithTable(page, "Tia Tiler");
    await control.query(MAKE_ADMINISTRATOR, [email]);
    const tableId =
      /\/t\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1] ?? "";
    const post = (path: string, body: unknown) =>
      page.evaluate(
        async ([path, body]) =>
          (
            await fetch(`/trpc/${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status,
        [path, body] as const,
      );
    for (const name of ["lat", "lon"]) {
      expect(
        await post("catalog.addColumn", { tableId, name, fieldType: "number" }),
      ).toBe(200);
    }
    expect(
      await post("rows.insertMany", {
        tableId,
        rows: [{ name: "Paris", lat: "48.85", lon: "2.35" }],
      }),
    ).toBe(200);
    const openMap = async () => {
      await page.getByRole("button", { name: "New view" }).click();
      await page.getByRole("menuitem", { name: "Map" }).first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create", exact: true })
        .click();
      await expect(page.getByText("1 point")).toBeVisible();
    };

    // No tile server: the plain background, and nothing asked of anyone.
    await openMap();
    const mapUrl = page.url();
    await expect(
      page.locator('img[src^="https://tiles.example.org/"]'),
    ).toHaveCount(0);
    expect(asked).toEqual([]);

    await page.goto("/admin/instance");
    const tiles = page.getByLabel("Map tiles", { exact: true });
    // Not over HTTPS: refused, and nothing changes.
    await tiles.fill("http://tiles.example.org/{z}/{x}/{y}.png");
    await page.getByRole("button", { name: "Save the map tiles" }).click();
    // A change made in Administration asks for the proof (ADR 0073).
    await proveItIsYou(page);
    await expect(page.getByText("Invalid input")).toBeVisible();
    await tiles.fill("https://tiles.example.org/{z}/{x}/{y}.png");
    await page.getByLabel("Credit shown on maps").fill("© Example Maps");
    await page.getByRole("button", { name: "Save the map tiles" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // The page's policy is the document's: read again, the map has its
    // background, Paris among its tiles, under the credit.
    await page.goto(mapUrl);
    await expect(page.getByText("1 point")).toBeVisible();
    const drawn = page.locator('img[src^="https://tiles.example.org/"]');
    await expect(drawn.first()).toBeVisible();
    await expect(
      page.locator('img[src="https://tiles.example.org/13/4149/2818.png"]'),
    ).toHaveCount(1);
    expect(
      await drawn.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth === 1),
      ),
    ).toBe(true);
    await expect(page.getByText("© Example Maps")).toBeVisible();
    expect(asked).toContain("/13/4149/2818.png");
    expect(await accessibilityViolations(page)).toEqual([]);

    // Taken away: maps go back to their plain background.
    await page.goto("/admin/instance");
    await page.getByLabel("Map tiles", { exact: true }).fill("");
    await page.getByLabel("Credit shown on maps").fill("");
    await page.getByRole("button", { name: "Save the map tiles" }).click();
    await expect(page.getByText("Settings saved").first()).toBeVisible();
    await page.goto(mapUrl);
    await expect(page.getByText("1 point")).toBeVisible();
    await expect(
      page.locator('img[src^="https://tiles.example.org/"]'),
    ).toHaveCount(0);
    expect(blocked).toEqual([]);
  } finally {
    await control.query(
      "delete from instance_settings where key in ('mapTileUrl', 'mapTileCredit')",
    );
    await control.end();
  }
});

/** One pixel, as a PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// How the instance presents itself (ADR 0072): an administrator gives it
// a name, a logo and a note; anyone who opens the sign-in page then sees
// them, and its mail goes out under that name, signed. It changes
// instance settings, and puts them back.
test("an administrator names the instance, and the sign-in page and its mail carry the name", async ({
  page,
  browser,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Identity Admin");
    await control.query(MAKE_ADMINISTRATOR, [email]);

    await page.goto("/admin");
    await openAdmin(page, "Instance", "Name and logo");
    await page.getByLabel("Name", { exact: true }).fill("Trial Register");
    await page
      .getByLabel("Note on the sign-in pages")
      .fill("For the staff of the study.\nAsk the data team for an account.");
    await page
      .getByRole("button", { name: "Save the name and the note" })
      .click();
    // The page said nothing of the proof: the server asked, and the change
    // went through once it was given (ADR 0073).
    await proveItIsYou(page);
    await expect(page.getByText("Settings saved")).toBeVisible();
    // The browser's tab carries the name at once.
    await expect(page).toHaveTitle("Trial Register");

    // What is called an image and is not one is refused where it arrives.
    await page.getByLabel("Choose an image").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    });
    await expect(
      page.getByText("A logo is a PNG, JPEG, or WebP image of 256 KiB at most"),
    ).toBeVisible();
    await page.getByLabel("Choose an image").setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: PIXEL,
    });
    await expect(page.getByText("Logo saved")).toBeVisible();
    await expect(
      page.getByRole("img", { name: "The logo in use" }),
    ).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);

    // Its mail: under its name, closed by its signature.
    await page.getByLabel("Signature, in English").fill("The data team");
    await page.getByRole("button", { name: "Save the mail settings" }).click();
    await expect(page.getByText("Settings saved").first()).toBeVisible();
    await page.getByRole("button", { name: "Send me a test email" }).click();
    const mail = await mailedMessage(email, "Trial Register: test message");
    expect(mail.fromName).toBe("Trial Register");
    expect(mail.text).toMatch(/-- \r?\nThe data team/);

    // Someone who has no account opens the sign-in page.
    const own = await browser.newContext(from("198.51.100.22"));
    const visitor = await own.newPage();
    const visitorBlocked = watchPolicy(visitor);
    await visitor.goto("/login");
    await expect(visitor.getByText("Trial Register")).toBeVisible();
    await expect(
      visitor.getByText("Ask the data team for an account."),
    ).toBeVisible();
    await expect(visitor).toHaveTitle("Trial Register");
    const logo = visitor.locator('img[src^="/api/instance/logo?v="]');
    await expect(logo).toBeVisible();
    expect(
      await logo.evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBe(1);
    expect(await accessibilityViolations(visitor)).toEqual([]);
    // On a phone, the name and the note still stand above the form.
    await visitor.setViewportSize({ width: 390, height: 800 });
    await expect(visitor.getByText("Trial Register")).toBeVisible();
    await expect(visitor.getByLabel("Email")).toBeVisible();
    expect(visitorBlocked).toEqual([]);
    await own.close();

    // On a phone the navigation is folded away, and the bar over the
    // page says where one is: under the instance's name, as the
    // navigation does. It wrote the product's.
    await page.setViewportSize({ width: 390, height: 800 });
    const bar = page
      .getByRole("button", { name: "Open the navigation" })
      .locator("..");
    await expect(bar).toHaveText("Trial Register");
    await page.setViewportSize({ width: 1280, height: 720 });

    // Taken away: the product's mark and name are back.
    await page.getByRole("button", { name: "Remove the logo" }).click();
    await expect(page.getByText("Logo removed")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("");
    await page.getByLabel("Note on the sign-in pages").fill("");
    await page
      .getByRole("button", { name: "Save the name and the note" })
      .click();
    await expect(page).toHaveTitle("AnyGridDB");
    expect(blocked).toEqual([]);
  } finally {
    await control.query(
      "delete from instance_settings where key in ('instanceName', 'signInMessage', 'mailSignatureEn')",
    );
    await control.query("delete from instance_logo");
    await control.end();
  }
});

// The administration API (ADR 0086): an administrator makes a token for
// one scope, with the proof; a script calls the API with the token alone
// and changes a setting of the instance's running; it is refused a
// setting that decides who gets in, and what its scope does not name; once
// the token is revoked it is refused everything.
test("an administrator makes a token for a script, which changes a setting, and revokes it", async ({
  page,
}) => {
  const blocked = watchPolicy(page);
  const control = new pg.Client({ connectionString: controlUrl });
  await control.connect();
  try {
    const { email } = await signUpWithTable(page, "Tess Token");
    await control.query(MAKE_ADMINISTRATOR, [email]);
    await page.goto("/admin");
    await openAdmin(page, "Connections", "Administration API");
    await expect(
      page.getByLabel("Address of the API", { exact: true }),
    ).toHaveValue(/^https:\/\/[^/]+\/api\/v1\/admin$/);
    await page.getByLabel("Token name", { exact: true }).fill("Nightly");
    await page.getByRole("checkbox", { name: /^Settings/ }).check();
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Make a token" }).click();
    await proveItIsYou(page);
    const token = await page
      .getByLabel("New token", { exact: true })
      .inputValue();
    expect(token).toMatch(/^aga_[\w-]{43}$/);

    // A script: the token alone, no session.
    const script = (method: string, path: string, body?: unknown) =>
      page.evaluate(
        async ([method, path, body, token]) => {
          const response = await fetch(`/api/v1/admin${path}`, {
            method,
            credentials: "omit",
            headers: {
              authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return {
            status: response.status,
            body: (await response.json()) as { code?: string; banner?: string },
          };
        },
        [method, path, body, token] as const,
      );
    const changed = await script("PATCH", "/settings", {
      banner: "Upgrade tonight at ten",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.banner).toBe("Upgrade tonight at ten");
    // Who gets in is changed on screen, with the proof; and the token's
    // scope is settings alone.
    const refused = await script("PATCH", "/settings", { mfaScope: "admins" });
    expect([refused.status, refused.body.code]).toEqual([
      403,
      "admin_token_setting",
    ]);
    const outside = await script("GET", "/accounts");
    expect([outside.status, outside.body.code]).toEqual([
      403,
      "admin_token_scope",
    ]);
    // Everyone reads the banner the script set.
    await page.reload();
    await expect(page.getByText("Upgrade tonight at ten")).toBeVisible();
    expect((await script("PATCH", "/settings", { banner: null })).status).toBe(
      200,
    );

    // The token is listed with what it may do, and revoked at once.
    const line = page.getByRole("row", { name: /Nightly/ });
    await expect(line).toContainText("Settings");
    await page
      .getByRole("button", { name: "Revoke the token Nightly" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await expect(line).toHaveCount(0);
    expect((await script("GET", "/settings")).status).toBe(401);
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(blocked).toEqual([]);
  } finally {
    await control.end();
  }
});

// When no administrator can sign in (ADR 0082), the operator runs a
// command where the instance runs: one account becomes an administrator
// and gets a link that sets its password. Its second factor stays, so the
// link alone opens nothing. It makes an administrator: after the journeys
// that count them.
test("the operator's command brings an administrator back in", async ({
  browser,
}) => {
  const own = await browser.newContext(from("198.51.100.40"));
  const page = await own.newPage();
  const blocked = watchPolicy(page);
  const stamp = uniqueStamp();
  const email = `e2e-recovered-${stamp}@example.com`;
  const name = `Recovered ${stamp}`;
  await signUp(page, { email, name, password: "correct-horse-battery" });
  const secret = await enableTotp(page);

  // An address nobody has: nothing is done, and the command says why.
  const unknown = recover("--email", `e2e-nobody-${stamp}@example.com`);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("No account has this address");
  expect(unknown.stdout).toBe("");

  const done = recover("--email", email);
  expect(done.status, done.stderr).toBe(0);
  expect(done.stdout).toContain("The account is now an administrator.");
  const link = /https:\/\/\S+\/reset\/\S+/.exec(done.stdout)?.[0] ?? "";
  expect(link).not.toBe("");

  // The link sets the password, in a browser that holds no session.
  const elsewhere = await browser.newContext(from("198.51.100.41"));
  const fresh = await elsewhere.newPage();
  await fresh.goto(new URL(link).pathname);
  await fresh
    .getByLabel("New password", { exact: true })
    .fill("a-recovered-passphrase");
  await fresh.getByLabel("New password, again").fill("a-recovered-passphrase");
  await fresh.getByRole("button", { name: "Set the password" }).click();
  await expect(fresh.getByText("Your password is changed")).toBeVisible();
  // Once: the link is spent, and the session of before ended.
  await fresh.reload();
  await expect(fresh.getByRole("alert")).toContainText(
    "This link no longer works",
  );
  await page.reload();
  await page.waitForURL(/\/login/);

  // The second factor stayed: the new password is asked for it.
  await signIn(fresh, email, "a-recovered-passphrase");
  await fresh.getByLabel("Authenticator code").fill(nextTotp(secret));
  await fresh.getByRole("button", { name: "Verify" }).click();
  await fresh.waitForURL((url) => !url.pathname.startsWith("/login"));

  // Administration is theirs, and its trail says where the role came from.
  await fresh.goto("/admin");
  await openAdmin(fresh, "Trails", "Sign-ins");
  const theirs = fresh.getByRole("row", { name: new RegExp(name) });
  await expect(
    theirs.filter({ hasText: "Made an administrator" }),
  ).toContainText("Command line");
  await expect(
    theirs.filter({ hasText: "Reset link sent" }).first(),
  ).toContainText("Command line");

  await own.close();
  await elsewhere.close();
  expect(blocked).toEqual([]);
});
