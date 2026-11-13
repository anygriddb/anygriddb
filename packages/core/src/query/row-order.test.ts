import { describe, expect, it } from "vitest";
import {
  buildMoveRows,
  buildOrderLock,
  buildRowPlaces,
  placeTarget,
} from "./row-order";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("row order", () => {
  it("names the row a place is beside, and the side", () => {
    expect(placeTarget({ before: A })).toEqual({ rowId: A, side: "before" });
    expect(placeTarget({ after: B })).toEqual({ rowId: B, side: "after" });
  });

  it("holds one table's order at a time", () => {
    expect(buildOrderLock("t_orders")).toEqual({
      text: `select pg_advisory_xact_lock(hashtext($1))`,
      values: ["ag_order:t_orders"],
    });
    expect(() => buildOrderLock(`t"x`)).toThrow();
  });

  it("finds places between a row and its neighbour on either side", () => {
    const before = buildRowPlaces({
      table: "t_orders",
      place: { before: A },
      count: 2,
    });
    expect(before.text).toBe(
      `select ag_row_positions((select n."ag_position" from "t_orders" n where (n."ag_position", n."ag_seq") < (x."ag_position", x."ag_seq") order by n."ag_position" desc, n."ag_seq" desc limit 1), x."ag_position", $2::int)::text[] as "positions" from "t_orders" x where x."id" = $1::uuid`,
    );
    expect(before.values).toEqual([A, 2]);
    const after = buildRowPlaces({
      table: "t_orders",
      place: { after: B },
      count: 1,
    });
    expect(after.text).toContain(
      `ag_row_positions(x."ag_position", (select n."ag_position" from "t_orders" n where (n."ag_position", n."ag_seq") > (x."ag_position", x."ag_seq") order by n."ag_position" asc, n."ag_seq" asc limit 1), $2::int)`,
    );
  });

  it("refuses a place with no row, or too many rows", () => {
    expect(() =>
      buildRowPlaces({
        table: "t_orders",
        place: { before: "1 or 1=1" },
        count: 1,
      }),
    ).toThrow("Invalid row id");
    for (const count of [0, 501, 1.5]) {
      expect(() =>
        buildRowPlaces({ table: "t_orders", place: { after: A }, count }),
      ).toThrow("Invalid limit");
    }
  });

  it("moves rows to their places in the order they had", () => {
    const move = buildMoveRows({
      table: "t_orders",
      rowIds: [B, A],
      positions: ["2.5", "2.75"],
    });
    expect(move.text).toBe(
      `update "t_orders" t set "ag_position" = p."position" from (select m."id", row_number() over (order by m."ag_position", m."ag_seq") as "n" from "t_orders" m where m."id" = any(array(select jsonb_array_elements_text($1::text::jsonb))::uuid[])) o join (values (1, $2::numeric), (2, $3::numeric)) as p ("n", "position") on p."n" = o."n" where t."id" = o."id" returning t."id"`,
    );
    expect(move.values).toEqual([JSON.stringify([B, A]), "2.5", "2.75"]);
  });

  it("refuses a move that names a row twice or lacks a place", () => {
    expect(() =>
      buildMoveRows({
        table: "t_orders",
        rowIds: [A, A],
        positions: ["1", "2"],
      }),
    ).toThrow("Invalid place");
    expect(() =>
      buildMoveRows({ table: "t_orders", rowIds: [A, B], positions: ["1"] }),
    ).toThrow("Invalid place");
    expect(() =>
      buildMoveRows({ table: "t_orders", rowIds: [A], positions: ["x"] }),
    ).toThrow("Invalid place");
    expect(() =>
      buildMoveRows({ table: "t_orders", rowIds: [], positions: [] }),
    ).toThrow("Invalid limit");
  });
});
