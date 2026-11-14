import { describe, expect, it } from "vitest";
import { NO_PROOF, asksProof } from "./proof-rule.js";

describe("asksProof", () => {
  it("asks for the proof before a change, named or not", () => {
    expect(asksProof("mutation", "admin.setAdmin")).toBe(true);
    expect(asksProof("mutation", "admin.updateSettings")).toBe(true);
    // A change nobody has written yet asks too.
    expect(asksProof("mutation", "admin.somethingNew")).toBe(true);
  });

  it("asks nothing of a read, nor of the changes it names", () => {
    expect(asksProof("query", "admin.users")).toBe(false);
    expect(asksProof("mutation", "admin.stepUp")).toBe(false);
    expect(asksProof("mutation", "admin.endSession")).toBe(false);
    for (const path of NO_PROOF) {
      expect(asksProof("mutation", path)).toBe(false);
    }
  });
});
