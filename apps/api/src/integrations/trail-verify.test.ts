import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ERASED_USER_ID } from "../data/erasure.js";
import { formatTrailLine } from "./syslog.js";
import {
  buildBatch,
  fingerprint,
  type TrailBatch,
  type TrailRow,
} from "./trail-shipping.js";
import {
  atOf,
  BatchChain,
  batchOf,
  describeTrailReport,
  Findings,
  LINE_BYTES,
  linesOf,
  microsOf,
  SentEvents,
  verdictOf,
  type EventContext,
  type Finding,
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

/** The findings a chain gives for these batches, read in this order. */
function chainOf(batches: readonly TrailBatch[]): {
  checked: number[];
  findings: Finding[];
} {
  const chain = new BatchChain();
  const findings = new Findings();
  const checked = batches
    .filter((batch) => chain.take(batch, findings))
    .map((batch) => batch.batch);
  chain.finish(findings);
  return { checked, findings: findings.listed };
}

/** The lines `linesOf` gives of these chunks, as a stream would hand them. */
async function collect(
  chunks: (Buffer | string)[],
): Promise<(string | null)[]> {
  async function* stream() {
    for (const chunk of chunks) yield await Promise.resolve(chunk);
  }
  const read: (string | null)[] = [];
  for await (const line of linesOf(stream())) read.push(line);
  return read;
}

describe("linesOf", () => {
  it("gives the lines of chunks cut anywhere, the last without its end", async () => {
    expect(await collect(['{"a"', ":1}\n\n{", Buffer.from('"b":2}')])).toEqual([
      '{"a":1}',
      "",
      '{"b":2}',
    ]);
  });

  it("reads past a line too long to be a batch, and goes on", async () => {
    const long = "x".repeat(LINE_BYTES / 4);
    expect(await collect([long, long, long, long, long, "\nnext\n"])).toEqual([
      null,
      "next",
    ]);
    expect(await collect(["x".repeat(LINE_BYTES + 1)])).toEqual([null]);
  });
});

describe("batchOf", () => {
  it("reads a batch as posted or as a syslog line", () => {
    const [first] = chain(2);
    const line = formatTrailLine(
      JSON.stringify(first?.batch),
      "2026-11-24T10:01:00.000Z",
      "box",
    );
    expect(batchOf(JSON.stringify(first?.batch))?.batch).toBe(1);
    expect(batchOf(line)).toEqual(first?.batch);
  });

  it("reads no batch in a line that holds none", () => {
    const sign = JSON.stringify({
      source: "anygriddb",
      action: "login_failure",
    });
    expect(batchOf(sign)).toBeNull();
    expect(batchOf("not json {")).toBeNull();
    expect(batchOf("plain text")).toBeNull();
    // A batch whose events are not events, which the checks would trip on.
    const [first] = chain(1);
    for (const events of [
      [null],
      [{ id: 7 }],
      [{ ...first?.batch.events[0], order: 3 }],
    ]) {
      expect(batchOf(JSON.stringify({ ...first?.batch, events }))).toBeNull();
    }
  });
});

describe("BatchChain", () => {
  it("finds nothing in batches that follow each other, in any order", () => {
    const batches = chain(2, 2, 1).map(({ batch }) => batch);
    expect(chainOf([...batches].reverse())).toEqual({
      checked: [3, 2, 1],
      findings: [],
    });
  });

  it("checks a batch read twice once", () => {
    const [one, two] = chain(1, 1).map(({ batch }) => batch);
    if (!one || !two) throw new Error("two batches");
    expect(chainOf([one, two, one])).toEqual({ checked: [1, 2], findings: [] });
  });

  it("says a batch lost, changed, out of the chain, or given twice", () => {
    const [one, two, three, four] = chain(1, 1, 1, 1).map(({ batch }) => batch);
    if (!one || !two || !three || !four) throw new Error("four batches");
    const changed = {
      ...two,
      events: two.events.map((event) => ({ ...event, userId: BOB })),
    };
    const foreign = buildBatch([row(9)], KEY, 4, "f".repeat(64));
    expect(chainOf([one, changed, four, foreign]).findings).toEqual([
      { kind: "batch_altered", batch: 2 },
      { kind: "batch_forked", batch: 4 },
      { kind: "batch_missing", batch: 3 },
    ]);
    expect(chainOf([one, three]).findings).toEqual([
      { kind: "batch_missing", batch: 2 },
    ]);
    expect(chainOf([one, { ...foreign, batch: 2 }]).findings).toContainEqual({
      kind: "chain_broken",
      batch: 2,
    });
  });

  it("counts the batches a forged number says are missing, without listing them all", () => {
    const [one] = chain(1).map(({ batch }) => batch);
    if (!one) throw new Error("one batch");
    const far = buildBatch([row(2)], KEY, Number.MAX_SAFE_INTEGER, one.digest);
    const chained = new BatchChain();
    const findings = new Findings();
    chained.take(one, findings);
    chained.take(far, findings);
    chained.finish(findings);
    expect(findings.listed).toHaveLength(1_000);
    expect(findings.listed.at(-1)).toEqual({
      kind: "batch_missing",
      batch: 1_001,
    });
    expect(findings.more).toBe(Number.MAX_SAFE_INTEGER - 2 - 1_000);
  });
});

describe("Findings", () => {
  it("lists a thousand, and counts the others", () => {
    const findings = new Findings();
    for (let batch = 0; batch < 1_002; batch += 1) {
      findings.add({ kind: "batch_altered", batch });
    }
    findings.addMissing(5, 8);
    expect(findings.listed).toHaveLength(1_000);
    expect(findings.more).toBe(5);
  });
});

describe("SentEvents", () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("finds the events it was given, in or out of their order", () => {
    for (const keys of [
      [1, 2, 3, 3, 9],
      [9, 3, 1, 3, 2],
    ]) {
      const sent = new SentEvents();
      keys.forEach((key, at) =>
        sent.add(key, id(at % 2 === 0 ? key : key + 100)),
      );
      sent.sort();
      for (const [at, key] of keys.entries()) {
        expect(sent.has(key, id(at % 2 === 0 ? key : key + 100))).toBe(true);
      }
      expect(sent.ends()?.first.key).toBe(1);
      expect(sent.ends()?.last.key).toBe(9);
    }
  });

  it("does not find an event of another key or id, nor in an empty set", () => {
    const sent = new SentEvents();
    for (let key = 0; key < 3_000; key += 1) sent.add(key, id(key));
    sent.sort();
    expect(sent.size).toBe(3_000);
    expect(sent.has(5, id(6))).toBe(false);
    expect(sent.has(3_000, id(3_000))).toBe(false);
    expect(new SentEvents().has(1, id(1))).toBe(false);
    expect(new SentEvents().ends()).toBeNull();
  });

  it("tells apart events of one time by their id", () => {
    const sent = new SentEvents();
    const at = microsOf("2026-11-24T10:00:00.000001Z");
    sent.add(at, id(2));
    sent.add(at, id(1));
    sent.sort();
    expect(sent.ends()?.first.id).toBe(id(1));
    expect(sent.has(at, id(2))).toBe(true);
    expect(sent.has(at, id(3))).toBe(false);
  });
});

describe("microsOf", () => {
  it("gives a time back as the copy writes it", () => {
    for (const at of [
      "2026-11-24T10:00:00.000001Z",
      "2019-01-01T00:00:00.999999Z",
      "2026-11-24T23:59:59.000000Z",
    ]) {
      expect(atOf(microsOf(at))).toBe(at);
    }
  });

  it("orders times as their text orders them", () => {
    expect(microsOf("2026-11-24T10:00:00.000002Z")).toBeGreaterThan(
      microsOf("2026-11-24T10:00:00.000001Z"),
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

describe("an event from before the write order", () => {
  const held = row(7, { order: null });
  const batch = buildBatch([held], KEY, 1, null);
  const entry = batch.events[0];
  if (!entry) throw new Error("one event");

  it("is sent with no order, and matches as it is held", () => {
    expect(entry.order).toBeNull();
    expect(chainOf([batch]).findings).toEqual([]);
    expect(verdictOf(entry, KEY.id, held, context)).toBe("matched");
  });

  it("does not match an event that took an order since", () => {
    expect(verdictOf(entry, KEY.id, { ...held, order: "7" }, context)).toBe(
      "event_altered",
    );
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
