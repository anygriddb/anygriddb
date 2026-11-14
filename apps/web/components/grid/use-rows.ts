import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useChannel } from "../../lib/realtime";
import { trpc, type RouterInputs } from "../../lib/trpc";
import type { RowItem } from "../../lib/types";

const PAGE_SIZE = 100;
/** A page that failed is asked again no sooner than this. */
const RETRY_AFTER_MS = 5_000;
/**
 * Changes made elsewhere are re-read once per burst: this long after the
 * first one, plus a random part so the tabs of a table do not all ask at
 * the same instant.
 */
const RELOAD_DELAY_MS = 300;
const RELOAD_SPREAD_MS = 200;
/** Rows changed elsewhere are re-read together, this long after the first. */
const ROWS_DELAY_MS = 150;
/** More changed rows than one read takes: the loaded pages are re-read. */
const MAX_ROWS_PER_READ = 500;

type ReadInput = RouterInputs["rows"]["read"];

type RowsQuery = Omit<
  ReadInput,
  "offset" | "limit" | "tableId" | "timeZone" | "withGroups"
>;

/** Every group of a grouped read, and where its rows start when known. */
export type Groups = Array<{
  keys: unknown[];
  depth: number;
  count: number;
  start?: number;
}>;

/**
 * How a view reads its rows: page after page as it scrolls; the same,
 * with where each group starts (a grouped grid); the same again, read
 * anew whenever a row changes, since a card moved to another stack moves
 * where every stack starts (a kanban); or one page of up to 1000 rows
 * (the views that lay out what they hold on the client).
 */
type RowsLayout = "pages" | "grouped" | "stacks" | "onePage";

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
  /**
   * Says an edit of these rows is being saved; call what it returns once
   * the save has answered. Reads made meanwhile do not replace the rows.
   */
  holdRows: (rowIds: readonly string[]) => () => void;
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
  /** The read under way for each page, by its number in `asked`. */
  private readonly inflight = new Map<number, number>();
  /** How many times each page was asked: only its last read is kept. */
  private readonly asked = new Map<number, number>();
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private reloading = false;
  private reloadAgain = false;
  private rowsTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changedRows = new Set<string>();
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

  /**
   * Rows whose edit is being saved, with how many saves are under way. A
   * read made meanwhile may see the row as it was before the save: it is
   * not taken, or a panel still open would start its next change from the
   * older value and save over the first.
   */
  private readonly saving = new Map<string, number>();

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
    return (edited || this.saving.has(fresh.id)) && current ? current : fresh;
  }

  constructor(
    readonly key: string,
    private readonly tableId: string,
    private readonly query: RowsQuery,
    readonly pageSize: number,
    /** What the first page says of the groups; the next ones say nothing. */
    private readonly groups: "none" | "starts" = "none",
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
    clearTimeout(this.reloadTimer);
    clearTimeout(this.rowsTimer);
    this.reloadTimer = undefined;
    this.rowsTimer = undefined;
    this.reloadAgain = false;
    this.changedRows.clear();
  }

  /** Read after an await: the store may have closed meanwhile. */
  private closed(): boolean {
    return !this.open;
  }

  /**
   * Reads one page. `again` asks for it even while a read of it is under
   * way, which may have begun before the change that calls for this one;
   * the answer of the older read is then dropped, whenever it arrives.
   */
  private async fetchPage(page: number, again = false) {
    if (!this.open || (this.inflight.has(page) && !again)) return;
    const ticket = (this.asked.get(page) ?? 0) + 1;
    this.asked.set(page, ticket);
    this.inflight.set(page, ticket);
    const superseded = () => this.asked.get(page) !== ticket;
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
        withGroups: page === 0 ? this.groups : "none",
      });
      if (this.closed() || superseded()) return;
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
      if (this.closed() || superseded()) return;
      this.failed.set(page, Date.now());
      if (page === 0 || this.pages.size === 0) {
        this.publish({ loading: false, error });
      }
    } finally {
      if (this.inflight.get(page) === ticket) this.inflight.delete(page);
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

  /** Reads again every page already loaded; resolves when all answered. */
  private reloadPages(): Promise<unknown> {
    this.failed.clear();
    if (this.snapshot.error) this.publish({ loading: true, error: null });
    const loaded = [...this.pages.keys()];
    return Promise.all(
      (loaded.length > 0 ? loaded : [0]).map((page) =>
        this.fetchPage(page, true),
      ),
    );
  }

  /** Reloads the pages already loaded, now: what the person just did. */
  readonly refresh = () => {
    void this.reloadPages();
  };

  /**
   * Others changed the table: reload, once for a burst of changes. A
   * script that writes ten rows a second makes each open tab read again
   * when the burst pauses or its last reload has answered, not ten times
   * a second; a change that lands during a reload calls for one more.
   */
  readonly refreshSoon = () => {
    if (!this.open) return;
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    if (this.reloadTimer !== undefined) return;
    this.reloadTimer = setTimeout(
      () => {
        this.reloadTimer = undefined;
        void this.reload();
      },
      RELOAD_DELAY_MS + Math.random() * RELOAD_SPREAD_MS,
    );
  };

  private async reload() {
    if (!this.open) return;
    this.reloading = true;
    // The pages read again bring the changed rows with them.
    clearTimeout(this.rowsTimer);
    this.rowsTimer = undefined;
    this.changedRows.clear();
    try {
      await this.reloadPages();
    } finally {
      this.reloading = false;
      if (this.reloadAgain) {
        this.reloadAgain = false;
        this.refreshSoon();
      }
    }
  }

  /**
   * Others changed these rows: read them again, together with the ones
   * that change in the next moment, in one request.
   */
  readonly refetchIdsSoon = (rowIds: readonly string[]) => {
    if (!this.open || rowIds.length === 0) return;
    // A reload on its way, or under way, reads them too.
    if (this.reloading || this.reloadTimer !== undefined) {
      this.refreshSoon();
      return;
    }
    for (const id of rowIds) this.changedRows.add(id);
    if (this.changedRows.size > MAX_ROWS_PER_READ) {
      this.changedRows.clear();
      clearTimeout(this.rowsTimer);
      this.rowsTimer = undefined;
      this.refreshSoon();
      return;
    }
    this.rowsTimer ??= setTimeout(() => {
      this.rowsTimer = undefined;
      const ids = [...this.changedRows];
      this.changedRows.clear();
      void this.refetchIds(ids);
    }, ROWS_DELAY_MS);
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
        rowIds: rowIds.slice(0, MAX_ROWS_PER_READ),
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

  readonly holdRows = (rowIds: readonly string[]) => {
    const held = [...new Set(rowIds)];
    for (const id of held) {
      this.saving.set(id, (this.saving.get(id) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of held) {
        const left = (this.saving.get(id) ?? 1) - 1;
        if (left > 0) this.saving.set(id, left);
        else this.saving.delete(id);
        // A read that began during the save is older than its outcome.
        this.edits.set(id, (this.edits.get(id) ?? 0) + 1);
      }
    };
  };

  readonly countExactly = async () => {
    const result = await trpc.rows.read.query({
      ...this.query,
      tableId: this.tableId,
      offset: 0,
      limit: 1,
      timeZone: TIME_ZONE,
      exactTotal: true,
      withGroups: "none",
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
 * Pages of rows fetched as they scroll into view. A grouped grid's first
 * page also says where each group starts, so its headers are laid out
 * before the rows under them are read; a kanban's, where each stack does.
 * Socket messages re-read changed rows by id, or reload the loaded pages.
 */
export function useRows(
  tableId: string,
  query: RowsQuery,
  layout: RowsLayout,
): RowsState {
  const pageSize = layout === "onePage" ? 1000 : PAGE_SIZE;
  const groups =
    layout === "grouped" || layout === "stacks" ? "starts" : "none";
  const key = JSON.stringify([tableId, query, pageSize, groups]);
  const [store, setStore] = useState(
    () => new RowPages(key, tableId, query, pageSize, groups),
  );
  // Another query: start over with a store of its own.
  if (store.key !== key) {
    setStore(new RowPages(key, tableId, query, pageSize, groups));
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
      // What others did is read once per burst, not once per message.
      if (
        message.type === "rows" &&
        message.op === "update" &&
        layout !== "stacks"
      ) {
        store.refetchIdsSoon(message.rowIds);
      } else if (
        message.type === "rows" ||
        message.type === "refresh" ||
        message.type === "delete"
      ) {
        store.refreshSoon();
      }
    },
    // Every tab comes back at once when the server does: spread out.
    resync: () => {
      store.refreshSoon();
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
      holdRows: store.holdRows,
      refetchIds: store.refetchIds,
      countExactly: store.countExactly,
    }),
    [snapshot, store],
  );
}
