import { describe, expect, it } from "vitest";
import { buttonUrl } from "./button-cell";

describe("buttonUrl", () => {
  it("fills the template with encoded values", () => {
    expect(
      buttonUrl("https://maps.example/?q={{ville}}&id={{record_id}}", {
        ville: "Saint-Étienne & co",
        record_id: "r1",
      }),
    ).toBe("https://maps.example/?q=Saint-%C3%89tienne%20%26%20co&id=r1");
  });

  it("refuses other schemes and broken URLs", () => {
    expect(buttonUrl("javascript:alert({{x}})", { x: "1" })).toBeNull();
    expect(buttonUrl("{{x}}", { x: "data:text/html,hi" })).toBeNull();
    expect(buttonUrl("not a url", {})).toBeNull();
  });
});
