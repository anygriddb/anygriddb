import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RowItem } from "../../lib/types";

const { read, get } = vi.hoisted(() => ({ read: vi.fn(), get: vi.fn() }));
vi.mock("../../lib/trpc", () => ({
  trpc: { rows: { read: { query: read }, get: { query: get } } },
}));
vi.mock("../../lib/realtime", () => ({ useChannel: () => undefined }));

const { RowPages } = await import("./use-rows");

const row = (score: number | null) =>
  ({ id: "r1", score }) as unknown as RowItem;

/** A store whose first page holds one row without a score. */
async function loaded() {
  read.mockResolvedValueOnce({
    rows: [row(null)],
    total: 1,
    totalEstimated: false,
    groups: [],
  });
  const store = new RowPages("key", "table", {}, 100);
  store.start();
  await vi.waitFor(() => {
    expect(store.rowAt(0)).toBeDefined();
  });
  return store;
}

/** A read the test answers when it chooses. */
function pendingGet() {
  let answer: (value: unknown) => void = () => undefined;
  get.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  return (rows: RowItem[]) => {
    answer({ rows });
  };
}

describe("rows store", () => {
  beforeEach(() => {
    read.mockReset();
    get.mockReset();
  });

  it("keeps an edit made while an older read of its row was on the way", async () => {
    const store = await loaded();
    const answer = pendingGet();
    const reading = store.refetchIds(["r1"]);
    store.patchLocal("r1", { score: 3 });
    answer([row(null)]);
    await reading;
    expect(store.rowAt(0)).toMatchObject({ score: 3 });
  });

  it("takes the stored row when nothing was edited during the read", async () => {
    const store = await loaded();
    store.patchLocal("r1", { score: 3 });
    const answer = pendingGet();
    const reading = store.refetchIds(["r1"]);
    answer([row(4)]);
    await reading;
    expect(store.rowAt(0)).toMatchObject({ score: 4 });
  });
});
