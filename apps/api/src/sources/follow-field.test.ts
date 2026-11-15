import { describe, expect, it } from "vitest";
import { followedField } from "./follow-field.js";

describe("a field refreshed from its client's column", () => {
  it("follows a column whose type changed", () => {
    expect(
      followedField({
        link: false,
        currentType: "single_select",
        currentExternal: "text",
        clientType: "number",
        clientExternal: "int",
      }),
    ).toEqual({ fieldType: "number", keepConfig: false });
  });

  it("keeps a type chosen here while the column's type is the same", () => {
    expect(
      followedField({
        link: false,
        currentType: "single_select",
        currentExternal: "text",
        clientType: "text",
        clientExternal: "text",
      }),
    ).toEqual({ fieldType: "single_select", keepConfig: true });
  });

  it("keeps a link", () => {
    expect(
      followedField({
        link: true,
        currentType: "relation_one_to_many",
        currentExternal: "uuid",
        clientType: "text",
        clientExternal: "uuid",
      }).fieldType,
    ).toBe("relation_one_to_many");
  });
});
