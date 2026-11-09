import { describe, expect, it } from "vitest";
import {
  mentionMarkup,
  mentionSegments,
  parseMentions,
  plainMentions,
} from "./mentions";

const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("mentions", () => {
  it("finds distinct mentioned users", () => {
    const body = `Merci ${mentionMarkup("Ada", ADA)} et ${mentionMarkup("Bob", BOB)}, cc ${mentionMarkup("Ada", ADA)}`;
    expect(parseMentions(body)).toEqual([ADA, BOB]);
    expect(plainMentions(body)).toBe("Merci @Ada et @Bob, cc @Ada");
  });

  it("splits text and mentions for display", () => {
    expect(mentionSegments(`Voir ${mentionMarkup("Ada [ops]", ADA)}.`)).toEqual(
      [
        { kind: "text", text: "Voir " },
        { kind: "mention", name: "Ada ops", userId: ADA },
        { kind: "text", text: "." },
      ],
    );
  });

  it("ignores malformed markup and plain at-signs", () => {
    expect(
      parseMentions("@Ada, mail ada@example.com, @[Ada](not-an-id)"),
    ).toEqual([]);
  });

  it("stops at twenty mentions", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      mentionMarkup(
        `U${index}`,
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    ).join(" ");
    expect(parseMentions(many)).toHaveLength(20);
  });
});
