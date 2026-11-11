import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  /** A page read the test answers when it chooses. */
  function pendingRead() {
    let answer: (value: unknown) => void = () => undefined;
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    return (rows: RowItem[]) => {
      answer({ rows, total: rows.length, totalEstimated: false, groups: [] });
    };
  }

  describe("changes made elsewhere", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reloads once for a burst of changes", async () => {
      const store = await loaded();
      vi.useFakeTimers();
      const answer = pendingRead();
      for (let change = 0; change < 10; change += 1) store.refreshSoon();
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(2);
      // Changes that land while the reload is on its way ask for one more,
      // once it has answered, and no more than one.
      const again = pendingRead();
      store.refreshSoon();
      store.refreshSoon();
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(2);
      answer([row(1)]);
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(3);
      again([row(2)]);
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(3);
      expect(store.rowAt(0)).toMatchObject({ score: 2 });
    });

    it("reads the rows changed in the same moment in one request", async () => {
      const store = await loaded();
      vi.useFakeTimers();
      get.mockResolvedValueOnce({ rows: [row(5)] });
      store.refetchIdsSoon(["r1"]);
      store.refetchIdsSoon(["r2", "r1"]);
      store.refetchIdsSoon(["r3"]);
      expect(get).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(get).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[0]?.[0]).toMatchObject({
        rowIds: ["r1", "r2", "r3"],
      });
      expect(store.rowAt(0)).toMatchObject({ score: 5 });
    });

    it("lets a reload stand for the rows changed meanwhile, and stops with the store", async () => {
      const store = await loaded();
      vi.useFakeTimers();
      read.mockResolvedValue({
        rows: [row(6)],
        total: 1,
        totalEstimated: false,
        groups: [],
      });
      store.refreshSoon();
      store.refetchIdsSoon(["r1"]);
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(2);
      expect(get).not.toHaveBeenCalled();
      // A closed store asks for nothing more.
      store.refreshSoon();
      store.close();
      store.refetchIdsSoon(["r1"]);
      await vi.advanceTimersByTimeAsync(600);
      expect(read).toHaveBeenCalledTimes(2);
      expect(get).not.toHaveBeenCalled();
    });
  });

  it("keeps the answer of the last read of a page, whenever an older one arrives", async () => {
    const store = await loaded();
    const older = pendingRead();
    const newer = pendingRead();
    store.refresh();
    store.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    newer([row(8)]);
    await vi.waitFor(() => {
      expect(store.rowAt(0)).toMatchObject({ score: 8 });
    });
    older([row(7)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.rowAt(0)).toMatchObject({ score: 8 });
  });

  it("keeps a row whose save is under way from the reads made meanwhile", async () => {
    const store = await loaded();
    store.patchLocal("r1", { score: 3 });
    const release = store.holdRows(["r1"]);
    // A read made after the edit, while the save has not answered: the
    // stored row is still the one from before.
    const during = pendingGet();
    const first = store.refetchIds(["r1"]);
    during([row(null)]);
    await first;
    expect(store.rowAt(0)).toMatchObject({ score: 3 });
    // One that began during the save and answers after it is older too.
    const late = pendingGet();
    const second = store.refetchIds(["r1"]);
    release();
    late([row(null)]);
    await second;
    expect(store.rowAt(0)).toMatchObject({ score: 3 });
    // Once the save answered, a new read brings what is stored.
    get.mockResolvedValueOnce({ rows: [row(4)] });
    await store.refetchIds(["r1"]);
    expect(store.rowAt(0)).toMatchObject({ score: 4 });
  });

  it("holds a row for as long as one of its saves is under way", async () => {
    const store = await loaded();
    store.patchLocal("r1", { score: 3 });
    const first = store.holdRows(["r1"]);
    const second = store.holdRows(["r1"]);
    first();
    first();
    get.mockResolvedValueOnce({ rows: [row(null)] });
    await store.refetchIds(["r1"]);
    expect(store.rowAt(0)).toMatchObject({ score: 3 });
    second();
    get.mockResolvedValueOnce({ rows: [row(9)] });
    await store.refetchIds(["r1"]);
    expect(store.rowAt(0)).toMatchObject({ score: 9 });
  });

  it("waitFor resolves once the asked indexes are loaded", async () => {
    const store = await loaded();
    await expect(store.waitFor(0, 0)).resolves.toBe(true);
  });

  it("waitFor fails when the store closed before the range arrived", async () => {
    const store = new RowPages("empty", "table", {}, 100);
    store.close();
    await expect(store.waitFor(0, 0)).resolves.toBe(false);
  });
});
