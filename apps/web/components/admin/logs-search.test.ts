import { describe, expect, it } from "vitest";
import {
  logsQuery,
  logsRangeInvalid,
  logsSearchSchema,
  nextLogs,
  sortLogs,
} from "./logs-search";
import { endOfMinute } from "./instant-range";

describe("the process log's address", () => {
  it("keeps what it knows and drops anything else", () => {
    expect(
      logsSearchSchema.parse({
        level: "warn",
        q: "  pool ",
        from: "2026-01-01T00:00:00.000Z",
        to: "not-a-date",
        sort: "message",
        dir: "asc",
        page: 3,
      }),
    ).toEqual({
      level: "warn",
      q: "pool",
      from: "2026-01-01T00:00:00.000Z",
      sort: "message",
      dir: "asc",
    });
    expect(logsSearchSchema.parse({ level: "fatal" })).toEqual({});
    expect(logsSearchSchema.parse({ q: "x".repeat(201) })).toEqual({});
  });

  it("asks for every kept line, newest first, unless the address says otherwise", () => {
    expect(logsQuery({}, { limit: 200, offset: 0 })).toEqual({
      level: "info",
      limit: 200,
      query: undefined,
      from: undefined,
      to: undefined,
      sort: "time",
      direction: "desc",
    });
    expect(logsQuery({ level: "error", q: "pool", dir: "asc" }, { limit: 200, offset: 0 })).toMatchObject({
      level: "error",
      query: "pool",
      direction: "asc",
    });
  });

  it("leaves the defaults out of the address", () => {
    expect(nextLogs({ level: "warn", q: "pool" }, { level: "info" })).toEqual({
      q: "pool",
    });
    expect(nextLogs({ q: "pool" }, { q: "" })).toEqual({});
    expect(nextLogs({}, { sort: "time", dir: "desc" })).toEqual({});
    expect(nextLogs({}, { sort: "level", dir: "asc" })).toEqual({
      sort: "level",
      dir: "asc",
    });
  });

  it("sorts by a column, time newest first and the others from A", () => {
    expect(sortLogs({}, "time")).toEqual({ dir: "asc" });
    expect(sortLogs({ dir: "asc" }, "time")).toEqual({});
    expect(sortLogs({}, "message")).toEqual({ sort: "message", dir: "asc" });
    expect(sortLogs({ sort: "message", dir: "asc" }, "message")).toEqual({
      sort: "message",
    });
  });

  it("refuses a range whose start is after its end", () => {
    expect(
      logsRangeInvalid({
        from: "2026-01-02T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      logsRangeInvalid({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("keeps a whole minute when the end is the start of one", () => {
    expect(endOfMinute("2026-01-01T00:05:00.000Z")).toBe(
      "2026-01-01T00:05:59.999Z",
    );
    expect(endOfMinute("2026-01-01T00:05:59.999Z")).toBe(
      "2026-01-01T00:05:59.999Z",
    );
  });
});
