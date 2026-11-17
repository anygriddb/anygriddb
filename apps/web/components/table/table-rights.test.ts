import { describe, expect, it } from "vitest";
import type { ViewItem } from "../../lib/types";
import { canEditView } from "./table-rights";

function view(partial: Partial<ViewItem>): ViewItem {
  return { id: "v1", personal: false, locked: false, ...partial } as ViewItem;
}

describe("canEditView", () => {
  it("stores an editor's settings on a shared view, and an owner's on a locked one", () => {
    expect(canEditView(view({}), "editor", true)).toBe(true);
    expect(canEditView(view({ locked: true }), "owner", true)).toBe(true);
    expect(canEditView(view({ personal: true }), "viewer", true)).toBe(true);
  });

  it("keeps local what a viewer changes, and what an editor changes on a locked view", () => {
    expect(canEditView(view({}), "viewer", true)).toBe(false);
    expect(canEditView(view({ locked: true }), "editor", true)).toBe(false);
    expect(canEditView(view({ personal: true }), "owner", false)).toBe(false);
    expect(canEditView(undefined, "owner", true)).toBe(false);
  });
});
