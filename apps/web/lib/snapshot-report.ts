import { useLingui } from "@lingui/react/macro";

/** What a snapshot's import, or a base's copy, could not bring as it was. */
type SnapshotReport = {
  files: number;
  filesMissing: number;
  people: number;
  peopleDropped: number;
  members: number;
  membersMissing: number;
  /** Absent from a report written before restore points. */
  membersLeft?: number;
};

/** The report in a finished job's result, when it has one. */
function snapshotReport(result: unknown): SnapshotReport | null {
  if (!result || typeof result !== "object" || !("report" in result)) {
    return null;
  }
  const report = result.report;
  return report && typeof report === "object"
    ? (report as SnapshotReport)
    : null;
}

/**
 * Says what did not come over, so it is not left to be found: one short
 * sentence per kind, none when everything came.
 */
export function useSnapshotGaps(): (result: unknown) => string[] {
  const { t } = useLingui();
  return (result) => {
    const report = snapshotReport(result);
    if (!report) return [];
    return [
      report.filesMissing > 0
        ? t`${{ count: report.filesMissing }} file(s) missing or damaged`
        : null,
      report.peopleDropped > 0
        ? t`${{ count: report.peopleDropped }} person(s) without access to the base, left out of Collaborator fields`
        : null,
      report.membersMissing > 0
        ? t`${{ count: report.membersMissing }} member(s) without an active account here`
        : null,
      (report.membersLeft ?? 0) > 0
        ? t`${{ count: report.membersLeft }} member(s) who have left the base since, left out`
        : null,
    ].filter((item): item is string => item !== null);
  };
}
