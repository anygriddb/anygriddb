import { describe, expect, it } from "vitest";
import {
  buildDuplicateJunction,
  buildDuplicateRows,
  buildDuplicateSelfLinks,
  buildSequenceAfter,
} from "./duplicate";

const USER = "11111111-1111-4111-8111-111111111111";
const TABLE = "22222222-2222-4222-8222-222222222222";

describe("copying a table's rows in SQL", () => {
  it("copies a range by sequence number, keeping the number and the place", () => {
    const statement = buildDuplicateRows({
      from: "t_tasks",
      to: "t_copy",
      columns: [
        { from: "title", to: "title" },
        { from: "team", to: "team_2" },
      ],
      after: "5000",
      limit: 5_000,
    });
    expect(statement.text).toContain(
      `insert into "t_copy" ("id", "ag_seq", "ag_position", "title", "team_2") select ag_uuidv7(), s."ag_seq", s."ag_position", s."title", s."team" from "t_tasks" s where s."ag_seq" > $1::bigint order by s."ag_seq" limit $2`,
    );
    expect(statement.values).toEqual(["5000", 5_000]);
    expect(
      buildSequenceAfter({ table: "t_copy", last: "6001" }).values,
    ).toEqual(['"t_copy"', "6001"]);
  });

  it("points links at the copied rows through their numbers", () => {
    expect(
      buildDuplicateSelfLinks({
        from: "t_tasks",
        to: "t_copy",
        fromColumn: "parent",
        toColumn: "parent",
        after: "0",
        upto: "5000",
      }).text,
    ).toContain(
      `join "t_tasks" r on r."id" = s."parent" join "t_copy" t on t."ag_seq" = r."ag_seq"`,
    );
    const junction = buildDuplicateJunction({
      from: "t_tasks",
      to: "t_copy",
      fromJunction: "j_related",
      toJunction: "j_related_2",
      self: true,
      field: "related",
      userId: USER,
      tableId: TABLE,
      after: "0",
      upto: "5000",
    });
    expect(junction.text).toContain(`select d."id", t."id" from "j_related" j`);
    expect(junction.text).toContain(`insert into "audit_events"`);
    expect(junction.values).toEqual(["0", "5000", USER, TABLE, "related"]);
    const other = buildDuplicateJunction({
      from: "t_tasks",
      to: "t_copy",
      fromJunction: "j_helpers",
      toJunction: "j_helpers_2",
      self: false,
      field: "helpers",
      userId: USER,
      tableId: TABLE,
      after: "0",
      upto: "5000",
    });
    expect(other.text).toContain(`select d."id", j."right_id"`);
    expect(other.text).not.toContain(`r."ag_seq"`);
  });

  it("refuses names that are not identifiers and numbers that are not sequence numbers", () => {
    expect(() =>
      buildDuplicateRows({
        from: 't"; drop table x; --',
        to: "t_copy",
        columns: [],
        after: "0",
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      buildDuplicateRows({
        from: "t_tasks",
        to: "t_copy",
        columns: [{ from: "title", to: "a b" }],
        after: "0",
        limit: 10,
      }),
    ).toThrow();
    expect(() =>
      buildDuplicateSelfLinks({
        from: "t_tasks",
        to: "t_copy",
        fromColumn: "parent",
        toColumn: "parent",
        after: "1 or 1=1",
        upto: "5000",
      }),
    ).toThrow();
    expect(() =>
      buildDuplicateRows({
        from: "t_tasks",
        to: "t_copy",
        columns: [],
        after: "0",
        limit: 0,
      }),
    ).toThrow("Invalid limit");
  });
});
