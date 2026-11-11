import { describe, expect, it } from "vitest";
import {
  asRunning,
  releaseNotify,
  retainedDismissal,
  type ReleaseStatus,
} from "./release-status.js";

function status(
  patch: Partial<ReleaseStatus> & Pick<ReleaseStatus, "latest" | "newer">,
): ReleaseStatus {
  return {
    current: "0.1.0",
    url: "https://github.com/anygriddb/anygriddb/releases/tag/v0.2.0",
    checkedAt: new Date("2026-01-01T00:00:00.000Z"),
    dismissedVersion: null,
    ...patch,
  };
}

describe("releaseNotify", () => {
  it("is silent while the opt-in is off", () => {
    expect(releaseNotify(false, status({ latest: "0.2.0", newer: true }))).toBe(
      false,
    );
  });

  it("notifies when a newer release is not dismissed", () => {
    expect(releaseNotify(true, status({ latest: "0.2.0", newer: true }))).toBe(
      true,
    );
  });

  it("stays quiet when up to date or dismissed", () => {
    expect(releaseNotify(true, status({ latest: "0.1.0", newer: false }))).toBe(
      false,
    );
    expect(
      releaseNotify(
        true,
        status({
          latest: "0.2.0",
          newer: true,
          dismissedVersion: "0.2.0",
        }),
      ),
    ).toBe(false);
    expect(releaseNotify(true, null)).toBe(false);
  });
});

describe("retainedDismissal", () => {
  it("keeps a dismissal for the same latest", () => {
    expect(
      retainedDismissal(
        { latest: "0.2.0", newer: true },
        { dismissedVersion: "0.2.0" },
      ),
    ).toBe("0.2.0");
  });

  it("clears a dismissal when a yet-newer release appears", () => {
    expect(
      retainedDismissal(
        { latest: "0.3.0", newer: true },
        { dismissedVersion: "0.2.0" },
      ),
    ).toBeNull();
  });

  it("clears a dismissal when the instance is up to date", () => {
    expect(
      retainedDismissal(
        { latest: "0.1.0", newer: false },
        { dismissedVersion: "0.2.0" },
      ),
    ).toBeNull();
  });
});

describe("asRunning", () => {
  it("closes the notice once the instance runs the release it found", () => {
    const found = status({ latest: "0.2.0", newer: true });
    expect(asRunning(found, "0.1.0")).toMatchObject({ newer: true });
    const upgraded = asRunning(found, "0.2.0");
    expect(upgraded).toMatchObject({ current: "0.2.0", newer: false });
    expect(releaseNotify(true, upgraded)).toBe(false);
  });

  it("tells a pre-release build nothing", () => {
    const found = status({ latest: "0.2.0", newer: true });
    expect(asRunning(found, "0.2.0-rc.1").newer).toBe(false);
  });
});
