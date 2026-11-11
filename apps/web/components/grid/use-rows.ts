import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useChannel } from "../../lib/realtime";
import { trpc, type RouterInputs } from "../../lib/trpc";
import type { RowItem } from "../../lib/types";

export const PAGE_SIZE = 100;
/** A page that failed is asked again no sooner than this. */
const RETRY_AFTER_MS = 5_000;

type ReadInput = RouterInputs["rows"]["read"];

export type RowsQuery = Omit<
  ReadInput,
  "offset" | "limit" | "tableId" | "timeZone"
>;

type Groups = Array<{ keys: unknown[]; depth: number; count: number }>;

/** What rendering reads; a new object whenever a loaded row changes. */
type Snapshot = {
  total: number;
  /** True while a large client table's total is its engine's estimate. */
  totalEstimated: boolean;
  loading: boolean;
  /** Why the first page could not be read; cleared by a refresh. */
  error: unknown;
  version: number;
  groups: Groups;
};

export type RowsState = Snapshot & {
  rowAt: (index: number) => RowItem | undefined;
  ensure: (start: number, end: number) => void;
  refresh: () => void;
  /** Rows currently loaded, in order, for selection math and clipboard. */
  loadedRows: () => RowItem[];
  /** Loads the index range, then resolves once every row in it is present. */
  waitFor: (start: number, end: number) => Promise<boolean>;
  patchLocal: (rowId: string, values: Record<string, unknown>) => void;
  refetchIds: (rowIds: string[]) => Promise<void>;
  /** Counts a large client table's rows exactly. */
  countExactly: () => Promise<void>;
};

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The loaded pages of one query on one table, outside React: pages arrive
 * and change without a render each, and components read a snapshot. A
 * new query gets a new store; a closed one drops the pages still coming.
 */
export class RowPages {
  private pages = new Map<number, RowItem[]>();
  private readonly inflight = new Set<number>();
  /** When each page last failed: it is not asked again at once. */
  private readonly failed = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Snapshot = {
    total: 0,
    totalEstimated: false,
    loading: true,
    error: null,
    version: 0,
    groups: [],
  };
  private open = false;
  /**
   * Local edits per row. A read that started before a row's latest edit
   * keeps the edited row: the edit's own read brings the stored one.
   */
  private readonly edits = new Map<string, number>();

  private editsOf(rowIds: Iterable<string>): Map<string, number> {
    return new Map([...rowIds].map((id) => [id, this.edits.get(id) ?? 0]));
  }

  /** `fresh`, unless the row was edited here since the read began. */
  private settled(
    fresh: RowItem,
    current: RowItem | undefined,
    before: Map<string, number>,
  ): RowItem {
    const edited =
      (this.edits.get(fresh.id) ?? 0) !== (before.get(fresh.id) ?? 0);
    return edited && current ? current : fresh;
  }

  constructor(
    readonly key: string,
    private readonly tableId: string,
    private readonly query: RowsQuery,
    readonly pageSize: number,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  private publish(change: Partial<Omit<Snapshot, "version">> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...change,
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) listener();
  }

  /** Starts loading; called again after a close, as Strict Mode does. */
  start() {
    this.open = true;
    void this.fetchPage(0);
  }

  close() {
    this.open = false;
  }

  /** Read after an await: the store may have closed meanwhile. */
  private closed(): boolean {
    return !this.open;
  }

  private async fetchPage(page: number) {
    if (!this.open || this.inflight.has(page)) return;
    this.inflight.add(page);
    const before = new Map(this.edits);
    try {
      // The first page counts the rows; the next ones need not.
      const result = await trpc.rows.read.query({
        ...this.query,
        tableId: this.tableId,
        offset: page * this.pageSize,
        limit: this.pageSize,
        timeZone: TIME_ZONE,
        withTotal: page === 0,
      });
      if (this.closed()) return;
      this.failed.delete(page);
      const current = new Map(
        (this.pages.get(page) ?? []).map((row) => [row.id, row]),
      );
      this.pages.set(
        page,
        result.rows.map((row) =>
          this.settled(row, current.get(row.id), before),
        ),
      );
      let total = result.total ?? this.snapshot.total;
      let estimated =
        result.total === null
          ? this.snapshot.totalEstimated
          : result.totalEstimated;
      const end = page * this.pageSize + result.rows.length;
      if (result.rows.length < this.pageSize) {
        // A short page is the end of the table: the total is known.
        total = end;
        estimated = false;
      } else if (estimated && end >= total) {
        // An estimate fell short: there is at least one page more.
        total = end + this.pageSize;
      }
      this.publish({
        total,
        totalEstimated: estimated,
        loading: false,
        error: null,
        ...(page === 0 ? { groups: result.groups } : {}),
      });
    } catch (error) {
      // A client's database may refuse or time out: the view says so and
      // offers to try again, rather than waiting for ever.
      if (this.closed()) return;
      this.failed.set(page, Date.now());
      if (page === 0 || this.pages.size === 0) {
        this.publish({ loading: false, error });
      }
    } finally {
      this.inflight.delete(page);
    }
  }

  readonly ensure = (start: number, end: number) => {
    // A read that failed waits for "try again", or a few seconds for a
    // page further down: rendering never asks again in a loop.
    if (this.snapshot.error) return;
    const now = Date.now();
    const first = Math.max(0, Math.floor(start / this.pageSize));
    const last = Math.max(first, Math.floor(Math.max(end, 0) / this.pageSize));
    for (let page = first; page <= last; page += 1) {
      if (
        !this.pages.has(page) &&
        now - (this.failed.get(page) ?? 0) > RETRY_AFTER_MS &&
        page * this.pageSize < Math.max(this.snapshot.total, 1)
      ) {
        void this.fetchPage(page);
      }
    }
  };

  /** Asks for the range, then waits until each index in it has a row. */
  readonly waitFor = async (start: number, end: number): Promise<boolean> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.closed() || this.snapshot.error) return false;
      // First page still on the way: we do not yet know how many rows exist.
      if (this.snapshot.loading && this.pages.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        continue;
      }
      if (this.snapshot.total === 0) return true;
      const last = Math.min(end, this.snapshot.total - 1);
      if (last < start) return true;
      this.ensure(start, last);
      let ready = true;
      for (let index = start; index <= last; index += 1) {
        if (!this.rowAt(index)) {
          ready = false;
          break;
        }
      }
      if (ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  };

  /** Reloads the pages already loaded. */
  readonly refresh = () => {
    this.failed.clear();
    if (this.snapshot.error) this.publish({ loading: true, error: null });
    const loaded = [...this.pages.keys()];
    for (const page of loaded.length > 0 ? loaded : [0]) {
      this.inflight.delete(page);
      void this.fetchPage(page);
    }
  };

  readonly refetchIds = async (rowIds: string[]) => {
    if (rowIds.length === 0) return;
    const wanted = new Set(rowIds);
    const present = [...this.pages.values()].some((rows) =>
      rows.some((row) => wanted.has(row.id)),
    );
    if (!present) return;
    const before = this.editsOf(rowIds);
    let result;
    try {
      result = await trpc.rows.get.query({
        tableId: this.tableId,
        rowIds: rowIds.slice(0, 500),
        timeZone: TIME_ZONE,
      });
    } catch {
      // The rows stay as they were; the next change or refresh reads them.
      return;
    }
    if (this.closed()) return;
    const fresh = new Map(result.rows.map((row) => [row.id, row]));
    for (const [page, rows] of this.pages) {
      this.pages.set(
        page,
        rows.map((row) => {
          const read = fresh.get(row.id);
          return read ? this.settled(read, row, before) : row;
        }),
      );
    }
    this.publish();
  };

  readonly patchLocal = (rowId: string, values: Record<string, unknown>) => {
    this.edits.set(rowId, (this.edits.get(rowId) ?? 0) + 1);
    for (const [page, rows] of this.pages) {
      const index = rows.findIndex((row) => row.id === rowId);
      if (index >= 0) {
        const next = [...rows];
        next[index] = { ...rows[index], ...values } as RowItem;
        this.pages.set(page, next);
      }
    }
    this.publish();
  };

  readonly countExactly = async () => {
    const result = await trpc.rows.read.query({
      ...this.query,
      tableId: this.tableId,
      offset: 0,
      limit: 1,
      timeZone: TIME_ZONE,
      exactTotal: true,
    });
    if (this.closed() || result.total === null) return;
    this.publish({
      total: result.total,
      totalEstimated: result.totalEstimated,
    });
  };

  readonly rowAt = (index: number) =>
    this.pages.get(Math.floor(index / this.pageSize))?.[index % this.pageSize];

  readonly loadedRows = () =>
    [...this.pages.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, rows]) => rows);
}

/**
 * Pages of rows fetched as they scroll into view. A grouped view loads one
 * page of up to 1000 rows so group headers can be laid out on the client.
 * Socket messages re-read changed rows by id, or reload the loaded pages.
 */
export function useRows(
  tableId: string,
  query: RowsQuery,
  options: { grouped: boolean },
): RowsState {
  const pageSize = options.grouped ? 1000 : PAGE_SIZE;
  const key = JSON.stringify([tableId, query, pageSize]);
  const [store, setStore] = useState(
    () => new RowPages(key, tableId, query, pageSize),
  );
  // Another query: start over with a store of its own.
  if (store.key !== key) {
    setStore(new RowPages(key, tableId, query, pageSize));
  }
  useEffect(() => {
    store.start();
    return () => {
      store.close();
    };
  }, [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useChannel(tableId, {
    message: (message) => {
      if (message.type === "rows" && message.op === "update") {
        void store.refetchIds(message.rowIds);
      } else if (
        message.type === "rows" ||
        message.type === "refresh" ||
        message.type === "delete"
      ) {
        store.refresh();
      }
    },
    resync: () => {
      store.refresh();
    },
  });

  return useMemo(
    () => ({
      ...snapshot,
      rowAt: store.rowAt,
      ensure: store.ensure,
      waitFor: store.waitFor,
      refresh: store.refresh,
      loadedRows: store.loadedRows,
      patchLocal: store.patchLocal,
      refetchIds: store.refetchIds,
      countExactly: store.countExactly,
    }),
    [snapshot, store],
  );
}
