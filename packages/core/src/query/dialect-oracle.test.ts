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

  it("filters is_not_empty without comparing to ''", async () => {
    const { buildReadRows } = await import("./read");
    const { emptySql } = await import("./filter-sql");
    expect(emptySql({ name: "name", kind: "text" }, ORACLE)).toBe(
      `(q."name" is null)`,
    );
    const table = {
      id: "t",
      storage: "external" as const,
      physicalName: "x",
      external: {
        sourceId: "s",
        dialect: "oracle" as const,
        schema: "CHINOOK",
        name: "AG_PARENT",
        key: ["ID"],
      },
      columns: [
        {
          id: "1",
          name: "name",
          label: "name",
          fieldType: "text" as const,
          config: {},
          physical: { name: "NAME", type: "varchar2(120)", zone: "UTC" },
        },
      ],
    };
    const sql = buildReadRows(
      { table, tables: new Map([["t", table]]), readable: () => true },
      {
        limit: 10,
        filter: {
          conjunction: "and",
          conditions: [{ column: "name", op: "is_not_empty" }],
        },
      },
    );
    expect(sql.text).toContain(`(not (q."name" is null))`);
    expect(sql.text).not.toMatch(/=\s*''/);
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
