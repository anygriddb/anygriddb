import { describe, expect, it } from "vitest";
import { EN, FR } from "../mail.test-helpers.js";
import { DIGEST_LINES, digestLine, digestText } from "./digest.js";

const AT = new Date("2026-03-05T14:30:00Z");

describe("a digest's lines", () => {
  it("say what happened in the instance's language, with the table", () => {
    const line = digestLine(FR, {
      event: "mention",
      payload: { table: "Factures" },
      createdAt: AT,
    });
    expect(line).toContain("5 mars 2026");
    expect(line).toContain("mentionné");
    expect(line).toContain("Factures");
    expect(line).not.toContain("mention ");
  });

  it("keep a security notice's own subject", () => {
    expect(
      digestLine(EN, {
        event: "password_changed",
        payload: { subject: "Your password was changed" },
        createdAt: AT,
      }),
    ).toContain("Your password was changed");
  });

  it("do not invent words for an event they have none for", () => {
    expect(
      digestLine(EN, { event: "inactive_soon", payload: null, createdAt: AT }),
    ).toContain("inactive_soon");
  });
});

describe("a digest's text", () => {
  const item = { event: "reply", payload: { table: "Orders" }, createdAt: AT };
  const settings = "https://grid.example.org/settings/account";
  const stop = "https://grid.example.org/notify/unsubscribe/x.y";

  it("lists everything that waited when it fits, and the way to stop", () => {
    const text = digestText(EN, "daily", [item, item], settings, stop);
    expect(text.match(/^- /gm)).toHaveLength(2);
    expect(text).not.toContain("more.");
    expect(text).toContain(`Stop this daily digest: ${stop}`);
    expect(text).toContain(settings);
  });

  it("counts what it does not list", () => {
    const many = Array.from({ length: DIGEST_LINES + 7 }, () => item);
    const text = digestText(FR, "weekly", many, settings, stop);
    expect(text.match(/^- /gm)).toHaveLength(DIGEST_LINES);
    expect(text).toContain("… et 7 de plus.");
    expect(text).toContain("résumé hebdomadaire");
  });
});
