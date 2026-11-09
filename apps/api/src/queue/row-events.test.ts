import { describe, expect, it } from "vitest";
import { changedColumns, eventOf } from "./row-events.js";

const entry = {
  id: "11111111-1111-4111-8111-111111111111",
  occurred_at: "2026-11-07T10:00:00.000Z",
  user_id: "22222222-2222-4222-8222-222222222222",
  table_id: "33333333-3333-4333-8333-333333333333",
  record_id: "44444444-4444-4444-8444-444444444444",
  source: "api",
};

describe("row events from audit entries", () => {
  it("lists the fields an update changed, without bookkeeping", () => {
    expect(
      changedColumns(
        {
          id: "x",
          title: "A",
          tags: ["a"],
          ag_updated_at: 1,
          ag_status: "draft",
        },
        {
          id: "x",
          title: "B",
          tags: ["a"],
          ag_updated_at: 2,
          ag_status: "draft",
        },
      ),
    ).toEqual(["title"]);
    expect(
      changedColumns({ ag_status: "draft" }, { ag_status: "submitted" }),
    ).toEqual(["ag_status"]);
  });

  it("turns status actions into status events and keeps the audit id", () => {
    const event = eventOf(
      {
        ...entry,
        action: "lock",
        old_value: { ag_status: "submitted" },
        new_value: { ag_status: "locked" },
      },
      2,
    );
    expect(event).toMatchObject({
      event: "status",
      columns: ["ag_status"],
      depth: 2,
      source: "api",
      auditId: entry.id,
      at: "2026-11-07T10:00:00.000Z",
    });
  });

  it("gives inserts and deletes no column list", () => {
    const inserted = eventOf(
      {
        ...entry,
        action: "insert",
        old_value: null,
        new_value: { title: "A" },
      },
      0,
    );
    expect(inserted.event).toBe("insert");
    expect(inserted.columns).toBeUndefined();
    expect(inserted.depth).toBeUndefined();
  });
});
