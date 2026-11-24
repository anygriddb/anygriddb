import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
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
