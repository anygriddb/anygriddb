import { describe, expect, it } from "vitest";
import type { TokenScope } from "../auth/tokens.js";
import { tokenMayCall } from "./token-rule.js";

const scope = (over: Partial<TokenScope> = {}): TokenScope => ({
  tokenId: "t",
  baseIds: null,
  readOnly: false,
  allowDelete: true,
  ...over,
});

describe("tokenMayCall", () => {
  it("lets a read-only token read, and export what it reads", () => {
    const reader = scope({ readOnly: true });
    expect(tokenMayCall(reader, "query", "rows.read")).toBe(true);
    expect(tokenMayCall(reader, "mutation", "jobs.startExport")).toBe(true);
  });

  it("refuses a read-only token any other change, a procedure added later included", () => {
    const reader = scope({ readOnly: true });
    expect(tokenMayCall(reader, "mutation", "catalog.deleteView")).toBe(false);
    expect(tokenMayCall(reader, "mutation", "someRouter.addedLater")).toBe(
      false,
    );
  });

  it("refuses every token what opens a way in for its account", () => {
    for (const path of [
      "auth.pendingInvitations",
      "auth.answerInvitation",
      "auth.acceptInvitation",
      "catalog.renewCalendarFeed",
      "catalog.revokeCalendarFeed",
    ]) {
      const type = path === "auth.pendingInvitations" ? "query" : "mutation";
      expect(tokenMayCall(scope(), type, path)).toBe(false);
    }
  });

  it("refuses every token a public link, which would outlive it", () => {
    for (const path of ["catalog.createShare", "catalog.createBaseShare"]) {
      for (const over of [{}, { baseIds: ["a"] }, { readOnly: true }]) {
        expect(tokenMayCall(scope(over), "mutation", path)).toBe(false);
      }
    }
    expect(tokenMayCall(scope(), "mutation", "catalog.revokeShare")).toBe(true);
    expect(tokenMayCall(scope(), "query", "catalog.shares")).toBe(true);
  });

  it("refuses every token the list of the account's tokens", () => {
    for (const over of [{}, { baseIds: ["a"] }, { readOnly: true }]) {
      expect(tokenMayCall(scope(over), "query", "auth.tokens")).toBe(false);
    }
    expect(tokenMayCall(scope(), "query", "auth.current")).toBe(true);
  });

  it("keeps a token limited to some bases off what lists the whole account", () => {
    const limited = scope({ baseIds: ["a"] });
    expect(tokenMayCall(limited, "query", "notifications.list")).toBe(false);
    expect(tokenMayCall(limited, "mutation", "shortcuts.pin")).toBe(false);
    expect(tokenMayCall(limited, "query", "rows.read")).toBe(true);
    expect(tokenMayCall(scope(), "query", "notifications.list")).toBe(true);
  });
});
