import { describe, expect, it } from "vitest";
import { addedPeople, commentNotifications } from "./notifications.js";

const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";
const base = {
  tableId: "44444444-4444-4444-8444-444444444444",
  rowId: "55555555-5555-4555-8555-555555555555",
  commentId: "66666666-6666-4666-8666-666666666666",
  authorId: ADA,
};

describe("commentNotifications", () => {
  it("notifies mentioned people and the author of the parent comment", () => {
    const items = commentNotifications({
      ...base,
      mentioned: [BOB],
      parentAuthorId: EVE,
    });
    expect(items.map((item) => [item.userId, item.kind])).toEqual([
      [BOB, "mention"],
      [EVE, "reply"],
    ]);
  });

  it("skips people already mentioned before an edit, and double notices", () => {
    expect(
      commentNotifications({
        ...base,
        mentioned: [BOB, EVE],
        alreadyMentioned: [BOB],
      }).map((item) => item.userId),
    ).toEqual([EVE]);
    expect(
      commentNotifications({
        ...base,
        mentioned: [EVE],
        parentAuthorId: EVE,
      }).map((item) => item.kind),
    ).toEqual(["mention"]);
  });
});

describe("addedPeople", () => {
  it("returns ids present after and not before", () => {
    expect(addedPeople([ADA], [ADA, BOB, BOB])).toEqual([BOB]);
    expect(addedPeople(null, [EVE])).toEqual([EVE]);
  });

  it("ignores removals and malformed values", () => {
    expect(addedPeople([ADA, BOB], [ADA])).toEqual([]);
    expect(addedPeople("x", { a: 1 })).toEqual([]);
  });
});
