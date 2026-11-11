import { describe, expect, it } from "vitest";
import { samlAssertionId } from "./enterprise.js";

describe("samlAssertionId", () => {
  it("reads the id of the assertion that was checked", () => {
    expect(samlAssertionId({ Assertion: { $: { ID: "_a1" } } })).toBe("_a1");
    expect(samlAssertionId({ "saml:Assertion": { $: { ID: "_a2" } } })).toBe(
      "_a2",
    );
  });

  it("finds none in what is not an assertion", () => {
    expect(samlAssertionId(undefined)).toBeNull();
    expect(samlAssertionId({})).toBeNull();
    expect(samlAssertionId({ Assertion: {} })).toBeNull();
    expect(samlAssertionId({ Assertion: { $: { ID: "" } } })).toBeNull();
    expect(samlAssertionId({ Assertion: { $: { ID: 7 } } })).toBeNull();
  });
});
