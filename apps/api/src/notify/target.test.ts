import { describe, expect, it } from "vitest";
import {
  assertNotifyTarget,
  isNotifyBlocked,
  redirectTarget,
  redirectWithinOrigin,
} from "./target";

const PUBLIC = [{ address: "203.0.113.10", family: 4 }];
const resolve = async () => PUBLIC;

describe("a redirect with a channel's credentials", () => {
  const from = new URL("https://hooks.example.com/in?key=1");

  it("is followed on the same origin", () => {
    expect(redirectWithinOrigin(from, "/moved")).toBe(
      "https://hooks.example.com/moved",
    );
  });

  it("is not followed to another host, port, or scheme", () => {
    for (const elsewhere of [
      "https://attacker.example/in",
      "https://hooks.example.com:8443/in",
      "http://hooks.example.com/in",
      "//attacker.example/in",
      "https://",
    ]) {
      expect(redirectWithinOrigin(from, elsewhere), elsewhere).toBeNull();
    }
  });
});

describe("notification targets", () => {
  it("accepts a public https address", async () => {
    const url = await assertNotifyTarget("https://hooks.example.com/in", {
      allowPrivate: false,
      resolve,
    });
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("refuses loopback, metadata, clear text, and a private address", async () => {
    await expect(
      assertNotifyTarget("https://127.0.0.1/hook", { allowPrivate: true }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    await expect(
      assertNotifyTarget("https://169.254.169.254/latest", {
        allowPrivate: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    await expect(
      assertNotifyTarget("https://[::1]/hook", { allowPrivate: true }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    await expect(
      assertNotifyTarget("http://hooks.example.com/in", {
        allowPrivate: true,
        resolve,
      }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    await expect(
      assertNotifyTarget("https://10.1.2.3/hook", { allowPrivate: false }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    await expect(
      assertNotifyTarget("https://hooks.example.com/in", {
        allowPrivate: false,
        resolve: async () => [{ address: "10.1.2.3", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    expect(isNotifyBlocked("100.100.100.200", 4, true)).toBe(true);
  });

  it("allows a private address only when the administrator has said so", async () => {
    const url = await assertNotifyTarget("https://10.1.2.3/hook", {
      allowPrivate: true,
    });
    expect(url.hostname).toBe("10.1.2.3");
    const named = await assertNotifyTarget("https://ntfy.example.com/hook", {
      allowPrivate: true,
      resolve: async () => [{ address: "192.168.1.9", family: 4 }],
    });
    expect(named.hostname).toBe("ntfy.example.com");
  });

  it("checks the address a redirect points at", async () => {
    const current = new URL("https://hooks.example.com/in");
    const next = redirectTarget(current, "https://169.254.169.254/latest");
    await expect(
      assertNotifyTarget(next, { allowPrivate: true }),
    ).rejects.toMatchObject({ code: "invalid_notify_target" });
    expect(redirectTarget(current, "/other")).toBe(
      "https://hooks.example.com/other",
    );
  });
});
