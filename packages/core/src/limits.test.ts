import { describe, expect, it } from "vitest";
import { MAX_AUTOMATION_ACTIONS } from "./automation";
import { MAX_ACTIVE_JOBS } from "./jobs";
import { ceilingOf, LIMITS } from "./limits";
import { MAX_READ_LIMIT } from "./query/read";

describe("the catalogue of limits", () => {
  it("holds each ceiling once, at the value ADR 0132 records", () => {
    expect(
      Object.fromEntries(
        Object.entries(LIMITS).map(([id, entry]) => [id, entry.value]),
      ),
    ).toEqual({
      "attachment.max_bytes": 20_971_520,
      "automation.max_actions": 20,
      "automation.max_delay_minutes": 1_440,
      "automation.max_loop_rows": 100,
      "automation.max_nested_actions": 10,
      "automation.max_script_chars": 20_000,
      "automation.max_secrets": 10,
      "automation.runs_per_minute": 300,
      "copy.max_rows": 100_000,
      "display.calendar_rows": 1_000,
      "display.list_rows": 5_000,
      "display.map_places": 5_000,
      "export.file_hours": 24,
      "export.max_rows": 1_000_000,
      "import.json_bytes": 20_971_520,
      "import.max_rows": 1_000_000,
      "import.text_bytes": 268_435_456,
      "import.xlsx_bytes": 67_108_864,
      "jobs.active_per_account": 5,
      "jobs.retention_days": 7,
      "rate.api": 600,
      "rate.app": 3_000,
      "rate.auth": 20,
      "rate.form_upload": 30,
      "rate.oauth": 120,
      "rate.report": 30,
      "rate.share": 240,
      "rate.sign_on": 300,
      "rate.upload": 120,
      "read.groups": 2_000,
      "read.rows_per_page": 1_000,
      "retention.automation_runs_days": 30,
      "retention.deliveries_days": 30,
      "retention.digest_days": 30,
      "retention.notifications_read_days": 90,
      "retention.notifications_unread_days": 180,
      "retention.source_load_days": 30,
      "sockets.channels_per_socket": 128,
      "sockets.per_account": 64,
      "view.groups": 5,
    });
  });

  it("names each limit as a family and a ceiling, each a positive whole number", () => {
    for (const [id, entry] of Object.entries(LIMITS)) {
      expect(id, id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(Number.isInteger(entry.value) && entry.value > 0, id).toBe(true);
      // What a screen keeps to never refuses: it says what it left out.
      if (entry.kind === "display") expect(entry.scope, id).toBe("view");
    }
  });

  it("is what the code reads, and nothing else", () => {
    expect(MAX_ACTIVE_JOBS).toBe(ceilingOf("jobs.active_per_account"));
    expect(MAX_READ_LIMIT).toBe(ceilingOf("read.rows_per_page"));
    expect(MAX_AUTOMATION_ACTIONS).toBe(ceilingOf("automation.max_actions"));
    // A ceiling the catalogue does not hold is no ceiling.
    expect(() => ceilingOf("nonsense" as never)).toThrow();
  });
});
