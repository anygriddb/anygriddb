import { describe, expect, it } from "vitest";
import {
  buildPlacesInRange,
  buildPositionsAfter,
  buildRowIdsBySeq,
  buildRowSeqs,
  buildSnapshotForeignKeys,
  buildSnapshotJunction,
  buildSnapshotKeys,
  buildSnapshotStatus,
  MAX_SNAPSHOT_LINK_PAIRS,
} from "./snapshot-rows";

const USER = "11111111-1111-4111-8111-111111111111";
const TABLE = "22222222-2222-4222-8222-222222222222";
const ROW = "33333333-3333-4333-8333-333333333333";

describe("a snapshot's rows, by sequence number", () => {
  it("reads the next rows of a table past a number, with their place", () => {
    const statement = buildSnapshotKeys({
      table: "t_tasks",
      after: "1000",
      limit: 1000,
    });
    expect(statement.text).toBe(
      `select "id", "ag_seq"::text as "seq", "ag_position"::text as "position" from "t_tasks" where "ag_seq" > $1::bigint order by "ag_seq" limit $2`,
    );
    expect(statement.values).toEqual(["1000", 1000]);
    expect(buildRowSeqs({ table: "t_tasks", ids: [ROW] }).values).toEqual([
      [ROW],
    ]);
    expect(buildRowIdsBySeq({ table: "t_tasks", seqs: ["7"] })).toEqual({
      text: 'select "id"::text as "id", "ag_seq"::text as "seq" from "t_tasks" where "ag_seq" = any($1::bigint[])',
      values: [["7"]],
    });
    expect(buildPositionsAfter({ table: "t_tasks" })).toEqual({
      text: "select ag_advance_row_place($1::text)",
      values: ["t_tasks"],
    });
  });

  it("brings a table's far places next to its others, in their order", () => {
    const statement = buildPlacesInRange({ table: "t_tasks" });
    expect(statement.text).toContain(
      `where "ag_position" > 4503599627370496 or "ag_position" < -4503599627370496`,
    );
    expect(statement.text).toContain(
      `row_number() over (partition by "ag_position" > 0 order by "ag_position", "ag_seq")`,
    );
    expect(statement.values).toEqual([]);
    expect(() => buildPlacesInRange({ table: 'x"; drop' })).toThrow();
  });

  it("refuses a page past the read limit, a bad number, and a bad id", () => {
    expect(() =>
      buildSnapshotKeys({ table: "t_tasks", after: "0", limit: 1001 }),
    ).toThrow();
    expect(() =>
      buildSnapshotKeys({ table: "t_tasks", after: "-1", limit: 10 }),
    ).toThrow();
    expect(() =>
      buildSnapshotKeys({ table: 'x"; drop', after: "0", limit: 10 }),
    ).toThrow();
    expect(() => buildRowSeqs({ table: "t_tasks", ids: ["r1"] })).toThrow();
    expect(() => buildRowIdsBySeq({ table: "t_tasks", seqs: [] })).toThrow();
    expect(() =>
      buildRowIdsBySeq({ table: "t_tasks", seqs: ["1; drop"] }),
    ).toThrow();
    expect(() => buildRowSeqs({ table: "t_tasks", ids: [] })).toThrow();
  });

  it("links rows through a foreign key and through a junction, pair by pair", () => {
    const keys = buildSnapshotForeignKeys({
      from: "t_tasks",
      to: "t_teams",
      column: "team",
      fromSeqs: ["1", "2"],
      toSeqs: ["9", "9"],
    });
    expect(keys.text).toBe(
      `update "t_tasks" s set "team" = t."id" from unnest($1::bigint[], $2::bigint[]) as p ("from_seq", "to_seq") join "t_teams" t on t."ag_seq" = p."to_seq" where s."ag_seq" = p."from_seq"`,
    );
    expect(keys.values).toEqual([
      ["1", "2"],
      ["9", "9"],
    ]);
    const junction = buildSnapshotJunction({
      from: "t_tasks",
      to: "t_tasks",
      junction: "j_blocks",
      field: "blocks",
      userId: USER,
      tableId: TABLE,
      fromSeqs: ["1"],
      toSeqs: ["2"],
    });
    expect(junction.text).toContain(
      `insert into "j_blocks" ("left_id", "right_id") select s."id", t."id" from unnest($1::bigint[], $2::bigint[]) as p ("from_seq", "to_seq") join "t_tasks" s on s."ag_seq" = p."from_seq" join "t_tasks" t on t."ag_seq" = p."to_seq" on conflict do nothing`,
    );
    expect(junction.text).toContain(`'snapshot' from linked l group by`);
    expect(junction.values).toEqual([["1"], ["2"], USER, TABLE, "blocks"]);
  });

  it("refuses pairs that do not match, too many, or a bad number", () => {
    const base = {
      from: "t_tasks",
      to: "t_teams",
      column: "team",
    };
    expect(() =>
      buildSnapshotForeignKeys({ ...base, fromSeqs: ["1"], toSeqs: [] }),
    ).toThrow();
    expect(() =>
      buildSnapshotForeignKeys({ ...base, fromSeqs: [], toSeqs: [] }),
    ).toThrow();
    const many = Array.from({ length: MAX_SNAPSHOT_LINK_PAIRS + 1 }, () => "1");
    expect(() =>
      buildSnapshotForeignKeys({ ...base, fromSeqs: many, toSeqs: many }),
    ).toThrow();
    expect(() =>
      buildSnapshotForeignKeys({ ...base, fromSeqs: ["x"], toSeqs: ["1"] }),
    ).toThrow();
    expect(() =>
      buildSnapshotJunction({
        from: "t_tasks",
        to: "t_teams",
        junction: "j_x",
        field: "x",
        userId: "nobody",
        tableId: TABLE,
        fromSeqs: ["1"],
        toSeqs: ["2"],
      }),
    ).toThrow();
  });

  it("reads each row's dates, authors, and status when asked", () => {
    const statement = buildSnapshotKeys({
      table: "t_tasks",
      after: "0",
      limit: 10,
      state: true,
    });
    expect(statement.text).toContain(`"ag_status" as "status"`);
    expect(statement.text).toContain(
      `to_char("ag_created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`,
    );
    expect(statement.text).toContain(
      `to_char("ag_updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`,
    );
    expect(statement.text).toContain(`"ag_created_by"::text as "createdBy"`);
    expect(statement.text).toContain(`"ag_updated_by"::text as "updatedBy"`);
  });

  it("moves rows one step of their status, and refuses any other step", () => {
    const statement = buildSnapshotStatus({
      table: "t_tasks",
      seqs: ["1", "2"],
      from: "draft",
      to: "submitted",
    });
    expect(statement.text).toBe(
      `with moved as (update "t_tasks" set "ag_status" = $1 where "ag_seq" = any($2::bigint[]) and "ag_status" = $3 returning 1) select count(*)::int as "count" from moved`,
    );
    expect(statement.values).toEqual(["submitted", ["1", "2"], "draft"]);
    expect(
      buildSnapshotStatus({
        table: "t_tasks",
        seqs: ["1"],
        from: "submitted",
        to: "locked",
      }).values,
    ).toEqual(["locked", ["1"], "submitted"]);
    for (const [from, to] of [
      ["draft", "locked"],
      ["submitted", "submitted"],
    ] as const) {
      expect(() =>
        buildSnapshotStatus({ table: "t_tasks", seqs: ["1"], from, to }),
      ).toThrow();
    }
    expect(() =>
      buildSnapshotStatus({
        table: "t_tasks",
        seqs: [],
        from: "draft",
        to: "submitted",
      }),
    ).toThrow();
    expect(() =>
      buildSnapshotStatus({
        table: "t_tasks",
        seqs: ["x"],
        from: "draft",
        to: "submitted",
      }),
    ).toThrow();
  });
});
