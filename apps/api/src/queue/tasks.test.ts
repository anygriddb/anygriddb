import type { RowEvent } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { TASKS } from "./jobs.js";
import { consumerTasks } from "./tasks.js";

const event: RowEvent = {
  tableId: "aaaaaaaa-0000-4000-8000-000000000001",
  event: "update",
  rowId: "aaaaaaaa-0000-4000-8000-000000000002",
  actorId: "aaaaaaaa-0000-4000-8000-000000000003",
  at: "2026-01-01T00:00:00.000Z",
};
const everyone = { webhooks: true, assignments: true, automations: true };

describe("the consumers of a row event", () => {
  it("queues one job per consumer the table has", () => {
    expect(consumerTasks(event, everyone)).toEqual([
      TASKS.webhooksEvent,
      TASKS.assignmentsEvent,
      TASKS.automationsEvent,
    ]);
    expect(
      consumerTasks(event, {
        ...everyone,
        assignments: false,
        webhooks: false,
      }),
    ).toEqual([TASKS.automationsEvent]);
  });

  it("queues nothing for a table nobody listens to, or one it does not know", () => {
    expect(
      consumerTasks(event, {
        webhooks: false,
        assignments: false,
        automations: false,
      }),
    ).toEqual([]);
    expect(consumerTasks(event, undefined)).toEqual([]);
  });

  it("keeps an event without a row, or a deletion, from those who need a row", () => {
    // An import stands for many rows: webhooks hear of it, nobody else.
    expect(
      consumerTasks(
        { ...event, event: "import", rowId: undefined, count: 3 },
        everyone,
      ),
    ).toEqual([TASKS.webhooksEvent]);
    // Nobody is put on a row that is deleted.
    expect(consumerTasks({ ...event, event: "delete" }, everyone)).toEqual([
      TASKS.webhooksEvent,
      TASKS.automationsEvent,
    ]);
  });
});
