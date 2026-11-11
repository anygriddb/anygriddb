import { describe, expect, it } from "vitest";
import { ORACLE } from "./dialect-oracle";
import { formulaLimits, precisionLimit } from "./limits";

describe("ORACLE dialect", () => {
  const bind = (value: unknown) => `$${String(value)}`;

  it("pages with offset fetch and treats flags as numbers", () => {
    expect(ORACLE.limitOffset(100, 20, bind)).toBe(
      " offset 20 rows fetch next 100 rows only",
    );
    expect(ORACLE.cond(ORACLE.boolLiteral(true))).toBe("(1 = 1)");
    expect(ORACLE.cond("x")).toBe("(x = 1)");
  });

  it("treats empty VARCHAR2 as null for filled text", () => {
    expect(ORACLE.textFilled(`t."name"`)).toBe(`(t."name" is not null)`);
    expect(ORACLE.textLength(`t."name"`)).toBe(`length(t."name")`);
  });

  it("compares text by code point and refuses regular expressions", () => {
    // By code point: each session's NLS_COMP and NLS_SORT are BINARY.
    expect(ORACLE.compareText("a", "=", "b")).toBe("(a = b)");
    expect(() =>
      ORACLE.regexMatch(
        "t.x",
        { pattern: "a+", groups: 0, caseless: false, ambiguous: false },
        bind,
      ),
    ).toThrow(expect.objectContaining({ code: "function_unavailable" }));
  });

  it("slices text without LEFT and RIGHT", () => {
    expect(ORACLE.textLeft("t.x", "3")).toBe("substr(t.x, 1, 3)");
    expect(ORACLE.textRight("t.x", "0")).toContain("case when 0 > 0");
  });

  it("builds one JSON row and link lists", () => {
    expect(
      ORACLE.row([
        ["id", `t."id"`],
        ["name", `t."name"`],
      ]),
    ).toContain(
      `json_object('id' value t."id", 'name' value t."name" returning clob) as "ag_row"`,
    );
    expect(
      ORACLE.linksAgg({
        id: `l."i"`,
        label: `l."l"`,
        from: "dual",
        where: "1 = 1",
        order: [`l."o0"`],
      }),
    ).toContain("json_arrayagg");
  });

  it("encodes engine limits for formulas", () => {
    expect(precisionLimit("oracle")).toEqual({
      code: "precision",
      engine: "oracle",
    });
    expect(formulaLimits("SQRT({a})", "oracle")).toEqual([
      {
        code: "approximate",
        engine: "oracle",
        fn: "SQRT",
        from: 0,
        to: 4,
      },
    ]);
  });
});
