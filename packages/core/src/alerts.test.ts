import { describe, expect, it } from "vitest";
import { alertMailDue, dueAlerts, type AlertFacts } from "./alerts";
import { INSTANCE_DEFAULTS } from "./instance";

const now = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const quiet: AlertFacts = {
  lastBackup: null,
  lastGoodBackup: null,
  storagePercent: 40,
  certificateExpires: new Date("2027-11-13T12:00:00Z"),
  unreachableSources: [],
  failures: 0,
};
const kinds = (facts: Partial<AlertFacts>, settings = INSTANCE_DEFAULTS) =>
  dueAlerts(settings, { ...quiet, ...facts }, now).map((alert) => alert.kind);

describe("the alerts that are due", () => {
  it("raises none while all is well, or before a first backup is reported", () => {
    expect(kinds({})).toEqual([]);
    const good = { finishedAt: hoursAgo(20), succeeded: true };
    expect(kinds({ lastBackup: good, lastGoodBackup: good })).toEqual([]);
  });

  it("tells a late backup from a failed one", () => {
    const good = { finishedAt: hoursAgo(37), succeeded: true };
    expect(kinds({ lastBackup: good, lastGoodBackup: good })).toEqual([
      "backup_late",
    ]);
    // Failed an hour ago, but one succeeded yesterday: not late yet.
    const failed = { finishedAt: hoursAgo(1), succeeded: false };
    expect(
      dueAlerts(
        INSTANCE_DEFAULTS,
        {
          ...quiet,
          lastBackup: failed,
          lastGoodBackup: { finishedAt: hoursAgo(25) },
        },
        now,
      ),
    ).toEqual([
      {
        kind: "backup_failed",
        subject: "",
        detail: {
          failedAt: "2026-11-13T11:00:00.000Z",
          lastGoodAt: "2026-11-12T11:00:00.000Z",
        },
      },
    ]);
    // Only failures so far: failed, and late.
    expect(kinds({ lastBackup: failed })).toEqual([
      "backup_failed",
      "backup_late",
    ]);
  });

  it("raises each other kind at its threshold, one alert per source", () => {
    expect(kinds({ storagePercent: 89 })).toEqual([]);
    expect(kinds({ storagePercent: 90 })).toEqual(["storage_full"]);
    // A store that is not a disk has no figure.
    expect(kinds({ storagePercent: null })).toEqual([]);
    expect(
      kinds({ certificateExpires: new Date("2026-11-28T12:00:00Z") }),
    ).toEqual([]);
    expect(
      dueAlerts(
        INSTANCE_DEFAULTS,
        { ...quiet, certificateExpires: new Date("2026-11-20T18:00:00Z") },
        now,
      ),
    ).toEqual([
      {
        kind: "certificate_expiring",
        subject: "",
        detail: { expiresAt: "2026-11-20T18:00:00.000Z", days: 7 },
      },
    ]);
    expect(
      dueAlerts(
        INSTANCE_DEFAULTS,
        {
          ...quiet,
          unreachableSources: [
            { id: "a", name: "ERP" },
            { id: "b", name: "CRM" },
          ],
        },
        now,
      ).map((alert) => `${alert.kind}:${alert.subject}`),
    ).toEqual(["source_unreachable:a", "source_unreachable:b"]);
    expect(kinds({ failures: 49 })).toEqual([]);
    expect(kinds({ failures: 50 })).toEqual(["failures"]);
  });

  it("raises nothing of a kind that is turned off", () => {
    const failed = { finishedAt: hoursAgo(100), succeeded: false };
    expect(
      kinds(
        {
          lastBackup: failed,
          storagePercent: 99,
          certificateExpires: hoursAgo(1),
          unreachableSources: [{ id: "a", name: "ERP" }],
          failures: 9_999,
        },
        {
          ...INSTANCE_DEFAULTS,
          alertBackupHours: 0,
          alertStoragePercent: 0,
          alertCertificateDays: 0,
          alertSources: false,
          alertFailures: 0,
        },
      ),
    ).toEqual([]);
  });

  it("mails when an alert opens, then once a day at most", () => {
    expect(alertMailDue(null, now)).toBe(true);
    expect(alertMailDue(hoursAgo(23), now)).toBe(false);
    expect(alertMailDue(hoursAgo(24), now)).toBe(true);
  });
});
