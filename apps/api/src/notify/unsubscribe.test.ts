import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyRing, sign } from "../auth/key-ring.js";
import {
  readUnsubscribeToken,
  unsubscribeToken,
  unsubscribeUrl,
} from "./unsubscribe.js";

const USER = "11111111-1111-4111-8111-111111111111";

describe("unsubscribe tokens", () => {
  const ring = keyRing(randomBytes(32));

  it("round-trips a payload", () => {
    const token = unsubscribeToken(ring, {
      userId: USER,
      event: "mention",
      channel: "email_immediate",
    });
    expect(readUnsubscribeToken(ring, token)).toEqual({
      userId: USER,
      event: "mention",
      channel: "email_immediate",
    });
  });

  it("refuses a tampered token and in-app channel", () => {
    const token = unsubscribeToken(ring, {
      userId: USER,
      event: "mention",
      channel: "email_daily",
    });
    expect(readUnsubscribeToken(ring, `${token}x`)).toBeNull();
    expect(
      readUnsubscribeToken(
        ring,
        unsubscribeToken(ring, {
          userId: USER,
          event: "mention",
          channel: "in_app",
        }),
      ),
    ).toBeNull();
  });

  it("carries no event for a digest, which drops its channel everywhere", () => {
    const token = unsubscribeToken(ring, {
      userId: USER,
      event: null,
      channel: "email_weekly",
    });
    expect(readUnsubscribeToken(ring, token)).toEqual({
      userId: USER,
      event: null,
      channel: "email_weekly",
    });
  });

  it("refuses a signed token whose event is not one", () => {
    const body = Buffer.from(
      JSON.stringify({ u: USER, e: "nothing", c: "email_daily" }),
    ).toString("base64url");
    const signature = sign(ring, "notify-prefs", body).toString("base64url");
    expect(readUnsubscribeToken(ring, `${body}~${signature}`)).toBeNull();
  });

  it("never ends like a file's name, which the server answers with a 404", () => {
    for (let index = 0; index < 50; index += 1) {
      const token = unsubscribeToken(keyRing(randomBytes(32)), {
        userId: USER,
        event: "mention",
        channel: "email_immediate",
      });
      expect(token).not.toContain(".");
    }
  });

  it("builds a public url", () => {
    expect(
      unsubscribeUrl("https://grid.example.org/", ring, {
        userId: USER,
        event: "reply",
        channel: "email_weekly",
      }),
    ).toMatch(/^https:\/\/grid\.example\.org\/notify\/unsubscribe\//);
  });
});
