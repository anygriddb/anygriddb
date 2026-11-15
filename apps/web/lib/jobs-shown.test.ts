import { describe, expect, it } from "vitest";
import { shownJobs } from "./jobs";

describe("shownJobs", () => {
  const jobs = [
    { id: "run", status: "running" as const },
    { id: "ok", status: "done" as const },
    { id: "bad", status: "failed" as const },
    { id: "stop", status: "cancelled" as const },
  ];

  it("keeps finished tasks when the person has not hidden them", () => {
    expect(shownJobs(jobs, false).map((job) => job.id)).toEqual([
      "run",
      "ok",
      "bad",
      "stop",
    ]);
  });

  it("drops finished tasks and keeps one that is still running", () => {
    expect(shownJobs(jobs, true).map((job) => job.id)).toEqual(["run"]);
  });
});
