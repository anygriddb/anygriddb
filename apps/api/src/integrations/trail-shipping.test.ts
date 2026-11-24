import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatTrailLine } from "./syslog.js";
import {
  BATCH_EVENTS,
  batchDigest,
  buildBatch,
  fingerprint,
  type TrailRow,
} from "./trail-shipping.js";

const KEY = { id: "0", key: randomBytes(32) };

function row(order: number, content = `["event",${String(order)}]`): TrailRow {
  return {
    id: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
    order: String(order),
    at: "2026-11-24T10:00:00.123456Z",
    action: "insert",
    userId: "11111111-1111-4111-8111-111111111111",
    actedAs: null,
    content,
  };
}

describe("buildBatch", () => {
  it("sends what each event is and a fingerprint, never its content", () => {
    const batch = buildBatch([row(1, '["secret value"]')], KEY, 1, null);
    expect(batch).toMatchObject({
      source: "anygriddb",
      action: "trail_batch",
      batch: 1,
      previous: null,
      key: "0",
    });
    expect(JSON.stringify(batch)).not.toContain("secret value");
    expect(batch.events[0]?.fingerprint).toBe(
      fingerprint(KEY.key, '["secret value"]'),
    );
    expect(batch.digest).toBe(batchDigest(batch));
  });

  it("gives another digest when any event, or the batch before, differs", () => {
    const batch = buildBatch([row(1), row(2)], KEY, 2, "a".repeat(64));
    expect(
      buildBatch([row(1), row(3)], KEY, 2, "a".repeat(64)).digest,
    ).not.toBe(batch.digest);
    expect(
      buildBatch([row(1), row(2)], KEY, 2, "b".repeat(64)).digest,
    ).not.toBe(batch.digest);
    expect(
      buildBatch(
        [row(1), row(2)],
        { ...KEY, key: randomBytes(32) },
        2,
        "a".repeat(64),
      ).digest,
    ).not.toBe(batch.digest);
  });

  it("stays a syslog line under 8 KiB when it is full", () => {
    const rows = Array.from({ length: BATCH_EVENTS }, (_, index) => ({
      ...row(9_000_000_000_000 + index),
      actedAs: "22222222-2222-4222-8222-222222222222",
      action: "catalog",
    }));
    const batch = buildBatch(
      rows,
      { ...KEY, id: "x".repeat(64) },
      9_000_000_000,
      "a".repeat(64),
    );
    const line = formatTrailLine(
      JSON.stringify(batch),
      "2026-11-24T10:00:00.000Z",
      "h".repeat(255),
    );
    expect(Buffer.byteLength(line)).toBeLessThan(8_192);
  });
});
