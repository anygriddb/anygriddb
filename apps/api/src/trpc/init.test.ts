import { describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { sharedLookup } from "./init.js";

/** A lookup that answers when the test says so. */
function gate() {
  let runs = 0;
  let open: (value: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const run = () => {
    runs += 1;
    return new Promise<string>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
  };
  return {
    run,
    runs: () => runs,
    open: (value: string) => {
      open(value);
    },
    fail: (error: Error) => {
      fail(error);
    },
  };
}

describe("lookups shared by the procedures of one request", () => {
  it("asks once for the procedures that start together", async () => {
    const ctx = {} as Context;
    const lookup = gate();
    const answers = Promise.all([
      sharedLookup(ctx, "user", lookup.run),
      sharedLookup(ctx, "user", lookup.run),
      sharedLookup(ctx, "user", lookup.run),
    ]);
    lookup.open("alice");
    expect(await answers).toEqual(["alice", "alice", "alice"]);
    expect(lookup.runs()).toBe(1);
  });

  it("asks again once the lookup answered, and for another request or question", async () => {
    const ctx = {} as Context;
    const lookup = gate();
    const first = sharedLookup(ctx, "user", lookup.run);
    lookup.open("alice");
    await first;
    // The session may have ended meanwhile: nothing is kept.
    const second = sharedLookup(ctx, "user", lookup.run);
    lookup.open("nobody");
    expect(await second).toBe("nobody");
    expect(lookup.runs()).toBe(2);

    // Another request, and another question of the same one, ask for
    // themselves.
    const other = gate();
    const actor = gate();
    const mine = sharedLookup(ctx, "user", lookup.run);
    const theirs = sharedLookup({} as Context, "user", other.run);
    const who = sharedLookup(ctx, "actor", actor.run);
    expect([lookup.runs(), other.runs(), actor.runs()]).toEqual([3, 1, 1]);
    lookup.open("alice");
    other.open("bob");
    actor.open("carol");
    expect(await Promise.all([mine, theirs, who])).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("gives a refusal to everyone who waited, and keeps none", async () => {
    const ctx = {} as Context;
    const lookup = gate();
    const both = Promise.allSettled([
      sharedLookup(ctx, "user", lookup.run),
      sharedLookup(ctx, "user", lookup.run),
    ]);
    lookup.fail(new Error("unauthorized"));
    expect((await both).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    const again = sharedLookup(ctx, "user", lookup.run);
    lookup.open("alice");
    expect(await again).toBe("alice");
    expect(lookup.runs()).toBe(2);
  });
});
