import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ERASED_USER_ID } from "../data/erasure.js";
import { formatTrailLine } from "./syslog.js";
import { buildBatch, fingerprint, type TrailRow } from "./trail-shipping.js";
import {
  checkChain,
  describeTrailReport,
  readBatches,
  verdictOf,
  type EventContext,
} from "./trail-verify.js";

const KEY = { id: "2026-11", key: randomBytes(32) };
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

function row(order: number, overrides: Partial<TrailRow> = {}): TrailRow {
  const id = `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`;
  return {
    id,
    order: String(order),
    at: `2026-11-24T10:00:0${String(order % 10)}.000001Z`,
    action: "update",
    userId: ALICE,
    actedAs: null,
    content: JSON.stringify([id, order, "update", { amount: order }]),
    ...overrides,
  };
}

function chain(...sizes: number[]) {
  let order = 0;
  let previous: string | null = null;
  return sizes.map((size, index) => {
    const rows = Array.from({ length: size }, () => row((order += 1)));
    const batch = buildBatch(rows, KEY, index + 1, previous);
    previous = batch.digest;
    return { batch, rows };
  });
}

const context: EventContext = {
  key: (id) => (id === KEY.id ? KEY.key : undefined),
  purgedBefore: "2025-11-24T00:00:00.000Z",
  exists: (userId) => userId === ALICE || userId === BOB,
};

describe("readBatches", () => {
  it("reads a batch a line, as posted or as a syslog line", () => {
    const [first, second] = chain(2, 1);
    const text = [
      JSON.stringify(first?.batch),
      formatTrailLine(
        JSON.stringify(second?.batch),
        "2026-11-24T10:01:00.000Z",
        "box",
      ),
      "",
    ].join("\n");
    const read = readBatches(text);
    expect(read.batches.map((batch) => batch.batch)).toEqual([1, 2]);
    expect(read.unreadable).toBe(0);
  });

  it("counts the lines that are not batches", () => {
    const sign = JSON.stringify({
      source: "anygriddb",
      action: "login_failure",
    });
    expect(readBatches(`${sign}\nnot json {\nplain text\n`)).toEqual({
      batches: [],
      unreadable: 3,
    });
  });
});

describe("checkChain", () => {
  it("finds nothing in batches that follow each other", () => {
    const batches = chain(2, 2, 1).map(({ batch }) => batch);
    expect(checkChain([...batches].reverse())).toEqual({
      ordered: batches,
      findings: [],
    });
  });

  it("says a batch lost, changed, out of the chain, or given twice", () => {
    const [one, two, three, four] = chain(1, 1, 1, 1).map(({ batch }) => batch);
    if (!one || !two || !three || !four) throw new Error("four batches");
    const changed = {
      ...two,
      events: two.events.map((event) => ({ ...event, userId: BOB })),
    };
    const foreign = buildBatch([row(9)], KEY, 4, "f".repeat(64));
    const { findings } = checkChain([one, changed, four, foreign]);
    expect(findings).toEqual([
      { kind: "batch_forked", batch: 4 },
      { kind: "batch_altered", batch: 2 },
      { kind: "batch_missing", batch: 3 },
    ]);
    expect(checkChain([one, three]).findings).toEqual([
      { kind: "batch_missing", batch: 2 },
    ]);
    expect(checkChain([one, { ...foreign, batch: 2 }]).findings).toContainEqual(
      {
        kind: "chain_broken",
        batch: 2,
      },
    );
  });
});

describe("verdictOf", () => {
  const [sent] = chain(1);
  const entry = sent?.batch.events[0];
  const held = sent?.rows[0];
  if (!entry || !held) throw new Error("one event");

  it("matches an event the database holds as it was sent", () => {
    expect(verdictOf(entry, KEY.id, held, context)).toBe("matched");
    expect(entry.fingerprint).toBe(fingerprint(KEY.key, held.content));
  });

  it("names an event changed, of another key, or given another author", () => {
    expect(
      verdictOf(
        entry,
        KEY.id,
        { ...held, content: `${held.content} ` },
        context,
      ),
    ).toBe("event_altered");
    expect(
      verdictOf(
        entry,
        KEY.id,
        { ...held, at: "2026-11-24T10:00:09Z" },
        context,
      ),
    ).toBe("event_altered");
    expect(verdictOf(entry, "gone", held, context)).toBe("key_unknown");
    expect(verdictOf(entry, KEY.id, { ...held, userId: BOB }, context)).toBe(
      "author_changed",
    );
    // The placeholder of an erasure, while the account still exists.
    expect(
      verdictOf(entry, KEY.id, { ...held, userId: ERASED_USER_ID }, context),
    ).toBe("author_changed");
  });

  it("takes an erasure for one once the account is gone", () => {
    expect(
      verdictOf(
        entry,
        KEY.id,
        { ...held, userId: ERASED_USER_ID },
        {
          ...context,
          exists: () => false,
        },
      ),
    ).toBe("erased");
  });

  it("takes a missing event for purged only when a purge could reach it", () => {
    expect(verdictOf(entry, KEY.id, undefined, context)).toBe("event_deleted");
    expect(
      verdictOf(entry, KEY.id, undefined, {
        ...context,
        purgedBefore: "2026-11-25T00:00:00.000Z",
      }),
    ).toBe("purged");
    expect(
      verdictOf(entry, KEY.id, undefined, { ...context, purgedBefore: null }),
    ).toBe("event_deleted");
  });
});

describe("describeTrailReport", () => {
  it("says what was found, one line each", () => {
    const text = describeTrailReport({
      batches: 2,
      events: 3,
      matched: 1,
      purged: 1,
      erased: 0,
      findings: [{ kind: "event_altered", batch: 2, id: ALICE }],
      more: 0,
      unreadable: 4,
    });
    expect(text.split("\n")).toEqual([
      "2 batches, 3 events: 1 as sent, 1 purged, 0 of an erased account",
      "4 lines of the file were not batches",
      `event changed since it was sent: batch 2, ${ALICE}`,
    ]);
  });

  it("says nothing was rewritten when nothing was", () => {
    expect(
      describeTrailReport({
        batches: 1,
        events: 1,
        matched: 1,
        purged: 0,
        erased: 0,
        findings: [],
        more: 0,
        unreadable: 0,
      }),
    ).toContain("nothing was rewritten");
  });
});
