import { describe, expect, it } from "vitest";
import { MAX_AUTOMATION_ACTIONS } from "./automation";
import { MAX_ACTIVE_JOBS } from "./jobs";
import {
  ceilingOf,
  limitIn,
  LIMITS,
  limitValuesSchema,
  SETTABLE_LIMITS,
} from "./limits";
import {
  INSTANCE_DEFAULTS,
  parseInstanceSettings,
  POLICY_BOUNDS,
} from "./instance";
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
      "retention.restore_point_days": 30,
      "retention.sign_in_days": 365,
      "retention.source_load_days": 30,
      "retention.trash_days": 30,
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

describe("the days kept that Settings and Security set", () => {
  it("are the settings' own bounds and defaults", () => {
    expect(POLICY_BOUNDS.trashDays).toEqual({ min: 7, max: 365 });
    expect(POLICY_BOUNDS.restorePointDays).toEqual({ min: 1, max: 365 });
    expect(POLICY_BOUNDS.authRetentionDays).toEqual({ min: 180, max: 365 });
    expect(INSTANCE_DEFAULTS.trashDays).toBe(ceilingOf("retention.trash_days"));
    expect(INSTANCE_DEFAULTS.authRetentionDays).toBe(
      ceilingOf("retention.sign_in_days"),
    );
  });

  it("are not set in Limits and usage", () => {
    expect(
      limitValuesSchema.safeParse({ "retention.trash_days": 60 }).success,
    ).toBe(false);
  });
});

describe("the limits an administrator sets", () => {
  it("are the rates and the rows of a file, each set within its bounds, the shipped value among them", () => {
    expect(
      SETTABLE_LIMITS.filter((id) => !id.startsWith("rate.")).sort(),
    ).toEqual(["export.max_rows", "import.max_rows"]);
    expect(SETTABLE_LIMITS).toHaveLength(11);
    for (const id of SETTABLE_LIMITS) {
      const [floor, top] = LIMITS[id].bounds;
      expect(floor <= LIMITS[id].value && LIMITS[id].value <= top, id).toBe(
        true,
      );
    }
    expect(
      limitValuesSchema.parse({ "rate.auth": 5, "rate.app": 30_000 }),
    ).toEqual({ "rate.auth": 5, "rate.app": 30_000 });
    expect(limitIn("rate.auth", { "rate.auth": 40 })).toBe(40);
    expect(limitIn("rate.auth", {})).toBe(20);
    expect(limitValuesSchema.parse({ "import.max_rows": 2_500_000 })).toEqual({
      "import.max_rows": 2_500_000,
    });
    expect(limitIn("export.max_rows", {})).toBe(1_000_000);
  });

  it("names the environment's variable that fixes the rows of a file", () => {
    expect(LIMITS["import.max_rows"].fixedBy).toBe("IMPORT_MAX_ROWS");
    expect(LIMITS["export.max_rows"].fixedBy).toBe("EXPORT_MAX_ROWS");
    expect(
      SETTABLE_LIMITS.filter((id) => id.startsWith("rate.")).every(
        (id) => !("fixedBy" in LIMITS[id]),
      ),
    ).toBe(true);
  });

  it("refuses a value past its bounds, a part of one, and a limit set elsewhere", () => {
    for (const values of [
      { "rate.auth": 4 },
      { "rate.auth": 121 },
      { "rate.api": 600.5 },
      { "read.rows_per_page": 500 },
      { "import.max_rows": 99_999 },
      { "export.max_rows": 10_000_001 },
    ]) {
      expect(
        limitValuesSchema.safeParse(values).success,
        JSON.stringify(values),
      ).toBe(false);
    }
    // A value stored past its bounds is not read: the limit keeps its own.
    expect(
      parseInstanceSettings({ limits: { "rate.auth": 1 } }).limits,
    ).toEqual({});
  });
});
