import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { circuitWord } from "./circuit-labels";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });

describe("a circuit's words", () => {
  it("name a shipped state, transition or template by its key", () => {
    expect(circuitWord(i18n, "state", { key: "in_review", label: "x" })).toBe(
      "In review",
    );
    expect(circuitWord(i18n, "transition", { key: "sign", label: "x" })).toBe(
      "Sign",
    );
    expect(
      circuitWord(i18n, "template", { key: "dual_approval", name: "x" }),
    ).toBe("Dual approval");
  });

  it("keep the stored name of a key that is not shipped", () => {
    expect(
      circuitWord(i18n, "state", { key: "audited", label: "Audited" }),
    ).toBe("Audited");
  });
});
