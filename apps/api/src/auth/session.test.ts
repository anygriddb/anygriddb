import { INSTANCE_DEFAULTS, sessionWindows } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  isSessionToken,
  planSessionRenewal,
  sessionCookieOptions,
} from "./session.js";

// The defaults: 15 minutes idle, 12 hours at most.
const WINDOWS = sessionWindows(INSTANCE_DEFAULTS);
const SESSION_TTL_MS = WINDOWS.idleMs;
const SESSION_MAX_AGE_MS = WINDOWS.maxMs;

describe("session cookies", () => {
  it("issues a short-lived HttpOnly Secure Strict cookie, host-only", () => {
    const expiresAt = new Date("2026-11-06T22:00:00.000Z");
    expect(SESSION_COOKIE).toBe("__Host-ag_session");
    expect(SESSION_TTL_MS).toBe(15 * 60 * 1000);
    expect(SESSION_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    expect(sessionCookieOptions(expiresAt)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      expires: expiresAt,
    });
  });

  it("rejects session tokens that are the wrong shape", () => {
    expect(isSessionToken("a".repeat(43))).toBe(true);
    expect(isSessionToken("short")).toBe(false);
    expect(isSessionToken(`${"a".repeat(43)}\r\n`)).toBe(false);
    expect(isSessionToken(undefined)).toBe(false);
  });
});

describe("planSessionRenewal", () => {
  const created = new Date("2026-11-07T08:00:00.000Z");

  it("slides the idle window when less than half of it is left", () => {
    const now = new Date(created.getTime() + 10 * 60 * 1000);
    const expires = new Date(created.getTime() + SESSION_TTL_MS);
    expect(planSessionRenewal(created, expires, now, WINDOWS)).toEqual(
      new Date(now.getTime() + SESSION_TTL_MS),
    );
  });

  it("keeps a fresh session and refuses to pass the absolute lifetime", () => {
    const fresh = new Date(created.getTime() + 60 * 1000);
    expect(
      planSessionRenewal(
        created,
        new Date(created.getTime() + SESSION_TTL_MS),
        fresh,
        WINDOWS,
      ),
    ).toBeNull();
    const ceiling = created.getTime() + SESSION_MAX_AGE_MS;
    expect(
      planSessionRenewal(
        created,
        new Date(ceiling),
        new Date(ceiling - 60 * 1000),
        WINDOWS,
      ),
    ).toBeNull();
    expect(
      planSessionRenewal(
        created,
        new Date(ceiling - 1),
        new Date(ceiling),
        WINDOWS,
      ),
    ).toBeNull();
  });
});

describe("planSessionRenewal under the instance's windows", () => {
  it("slides by the idle window the administrator chose, up to the lifetime", () => {
    const created = new Date("2026-11-07T08:00:00.000Z");
    const windows = sessionWindows({
      sessionIdleMinutes: 60,
      sessionMaxHours: 2,
    });
    const now = new Date(created.getTime() + 40 * 60 * 1000);
    const expires = new Date(created.getTime() + 60 * 60 * 1000);
    expect(planSessionRenewal(created, expires, now, windows)).toEqual(
      new Date(now.getTime() + 60 * 60 * 1000),
    );
    const late = new Date(created.getTime() + 110 * 60 * 1000);
    expect(
      planSessionRenewal(
        created,
        new Date(late.getTime() + 5 * 60 * 1000),
        late,
        windows,
      ),
    ).toEqual(new Date(created.getTime() + 2 * 60 * 60 * 1000));
  });
});
