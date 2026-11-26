import { describe, expect, it } from "vitest";
import {
  assertOutboundTarget,
  isOutboundBlocked,
  redirectTarget,
  redirectWithinOrigin,
} from "./target.js";

const PUBLIC = [{ address: "203.0.113.10", family: 4 }] as const;
const resolve = async () => PUBLIC;

describe("outbound address policy", () => {
  it("accepts a public https address", async () => {
    const url = await assertOutboundTarget("https://hooks.example.com/in", {
      allowPrivate: false,
      resolve,
    });
    expect(url.hostname).toBe("hooks.example.com");
  });

  it("refuses clear text, credentials in the URL, and empty hosts", async () => {
    for (const target of [
      "http://hooks.example.com/in",
      "https://user:pass@hooks.example.com/in",
      "https://",
      "hooks",
      "ftp://hooks.example.com/in",
    ]) {
      await expect(
        assertOutboundTarget(target, { allowPrivate: true, resolve }),
        target,
      ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    }
  });

  it("refuses loopback, link-local and metadata names, a private network allowed or not", async () => {
    for (const target of [
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://app.localhost/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/",
      "https://instance-data/",
    ]) {
      await expect(
        assertOutboundTarget(target, { allowPrivate: true }),
        target,
      ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    }
  });

  it("reaches a private network's own names only when that network is allowed, and checks what they resolve to", async () => {
    const onTheNetwork = async () => [{ address: "10.4.0.7", family: 4 }];
    for (const target of [
      "https://idp.corp.internal/",
      "https://sso.example.local/",
    ]) {
      await expect(
        assertOutboundTarget(target, {
          allowPrivate: false,
          resolve: onTheNetwork,
        }),
        target,
      ).rejects.toMatchObject({ code: "invalid_outbound_target" });
      const reached = await assertOutboundTarget(target, {
        allowPrivate: true,
        resolve: onTheNetwork,
      });
      expect(reached.href).toBe(target);
      await expect(
        assertOutboundTarget(target, {
          allowPrivate: true,
          resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        }),
        target,
      ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    }
  });

  it("refuses private addresses unless the administrator has said so", async () => {
    await expect(
      assertOutboundTarget("https://10.1.2.3/hook", { allowPrivate: false }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    await expect(
      assertOutboundTarget("https://192.168.1.9/hook", { allowPrivate: false }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    await expect(
      assertOutboundTarget("https://[fd00::1]/hook", { allowPrivate: false }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });

    const privateLiteral = await assertOutboundTarget("https://10.1.2.3/hook", {
      allowPrivate: true,
    });
    expect(privateLiteral.hostname).toBe("10.1.2.3");
    const named = await assertOutboundTarget("https://ntfy.example.com/hook", {
      allowPrivate: true,
      resolve: async () => [{ address: "192.168.1.9", family: 4 }],
    });
    expect(named.hostname).toBe("ntfy.example.com");
  });

  it("refuses reserved ranges even on a private network", async () => {
    for (const [address, family] of [
      ["0.1.2.3", 4],
      ["100.64.0.1", 4],
      ["127.0.0.1", 4],
      ["169.254.169.254", 4],
      ["192.0.0.1", 4],
      ["192.88.99.1", 4],
      ["198.18.0.1", 4],
      ["198.19.255.255", 4],
      ["224.0.0.1", 4],
      ["240.1.2.3", 4],
      ["::", 6],
      ["::1", 6],
      ["64:ff9b::1", 6],
      ["64:ff9b:1::1", 6],
      ["2001:0:4136:e378::1", 6],
      ["2002:c000:201::1", 6],
      ["fe80::1", 6],
      ["fec0::1", 6],
      ["ff02::1", 6],
      ["::ffff:127.0.0.1", 6],
      ["::ffff:7f00:1", 6],
      ["::ffff:a9fe:a9fe", 6],
      ["::ffff:198.18.0.1", 6],
      ["::ffff:c612:1", 6],
      ["::ffff:192.0.0.1", 6],
      ["::ffff:192.88.99.1", 6],
    ] as const) {
      expect(isOutboundBlocked(address, family, true), address).toBe(true);
    }
  });

  it("allows public addresses, including IPv6 and mapped public", () => {
    expect(isOutboundBlocked("93.184.216.34", 4, false)).toBe(false);
    expect(isOutboundBlocked("203.0.113.10", 4, false)).toBe(false);
    expect(isOutboundBlocked("2606:4700::1111", 6, false)).toBe(false);
    expect(isOutboundBlocked("::ffff:93.184.216.34", 6, false)).toBe(false);
    expect(isOutboundBlocked("198.17.255.255", 4, false)).toBe(false);
    expect(isOutboundBlocked("198.20.0.0", 4, false)).toBe(false);
  });

  it("refuses a name that resolves to a private or reserved address", async () => {
    await expect(
      assertOutboundTarget("https://hooks.example.com/in", {
        allowPrivate: false,
        resolve: async () => [{ address: "10.1.2.3", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    await expect(
      assertOutboundTarget("https://hooks.example.com/in", {
        allowPrivate: true,
        resolve: async () => [{ address: "198.18.0.1", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    await expect(
      assertOutboundTarget("https://hooks.example.com/in", {
        allowPrivate: false,
        resolve: async () => [],
      }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
  });

  it("refuses a name that does not resolve", async () => {
    await expect(
      assertOutboundTarget("https://hooks.invalid/hook", {
        allowPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
  });
});

describe("a redirect with credentials", () => {
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

  it("checks the address a redirect points at", async () => {
    const next = redirectTarget(
      new URL("https://hooks.example.com/in"),
      "https://169.254.169.254/latest",
    );
    await expect(
      assertOutboundTarget(next, { allowPrivate: true }),
    ).rejects.toMatchObject({ code: "invalid_outbound_target" });
  });
});
