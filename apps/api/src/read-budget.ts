import { getHeapStatistics } from "node:v8";
import { AppError } from "@anygriddb/core";

/**
 * What one request may hold of the rows it reads. A page of the grid, 100
 * rows, fits many times over; a page of 1,000 rows of the longest cells
 * does not, and is refused rather than built whole in memory (ADR 0110).
 */
const READ_BYTES_PER_REQUEST = 64 * 1024 * 1024;

/** What every request of this process may hold together. */
export class ReadMemory {
  private held = 0;

  constructor(readonly capacity: number) {}

  reserve(bytes: number): boolean {
    if (this.held + bytes > this.capacity) return false;
    this.held += bytes;
    return true;
  }

  give(bytes: number): void {
    this.held = Math.max(0, this.held - bytes);
  }
}

/** A quarter of the heap, and never less than one request's share. */
const processMemory = new ReadMemory(
  Math.max(
    READ_BYTES_PER_REQUEST,
    Math.floor(getHeapStatistics().heap_size_limit / 4),
  ),
);

/** One request's share. It holds what it took until the response has left. */
export class ReadBudget {
  private used = 0;
  private closed = false;

  constructor(
    private readonly memory: ReadMemory = processMemory,
    private readonly limit: number = READ_BYTES_PER_REQUEST,
  ) {}

  take(bytes: number): void {
    // The client has gone: what is still being read has nowhere to go.
    if (this.closed) throw new AppError("reads_busy");
    if (this.used + bytes > this.limit) throw new AppError("page_too_large");
    if (!this.memory.reserve(bytes)) throw new AppError("reads_busy");
    this.used += bytes;
  }

  release(): void {
    this.closed = true;
    this.memory.give(this.used);
    this.used = 0;
  }
}

/** A budget that ends with the response it serves. */
export function budgetFor(response: {
  once: (event: "close", listener: () => void) => unknown;
}): ReadBudget {
  const budget = new ReadBudget();
  response.once("close", () => {
    budget.release();
  });
  return budget;
}

/** Rows of a query taken from the server at a time under a budget. */
const BUDGET_STREAM_ROWS = 4;

/**
 * A query's rows, each counted as it arrives, so that what passes the
 * budget never reaches memory. Without a budget, the query as it is.
 */
export async function rowsWithin<Row>(
  query: {
    execute(): Promise<Row[]>;
    stream(chunkSize?: number): AsyncIterableIterator<Row>;
  },
  budget: ReadBudget | undefined,
): Promise<Row[]> {
  if (!budget) return query.execute();
  const rows: Row[] = [];
  for await (const row of query.stream(BUDGET_STREAM_ROWS)) {
    budget.take(rowsBytes([row]));
    rows.push(row);
  }
  return rows;
}

/** Control characters JSON writes in two bytes; the others take six. */
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** A string as JSON writes it: its UTF-8, its quotes, and its escapes. */
function jsonStringBytes(text: string): number {
  let bytes = Buffer.byteLength(text) + 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 1;
    else if (code < 0x20) bytes += SHORT_ESCAPES.has(code) ? 1 : 5;
  }
  return bytes;
}

/**
 * What these rows weigh once written out as JSON, escapes included: a cell
 * of control characters takes six times its length. Walked with a stack: a
 * JSON cell can nest deeper than a recursive walk would survive.
 */
export function rowsBytes(rows: readonly unknown[]): number {
  let bytes = 0;
  const pending: unknown[] = [...rows];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      bytes += jsonStringBytes(value);
    } else if (value instanceof Date) {
      bytes += 26;
    } else if (Buffer.isBuffer(value)) {
      bytes += value.length;
    } else if (Array.isArray(value)) {
      bytes += 2 + value.length;
      for (const item of value) pending.push(item);
    } else if (typeof value === "object" && value !== null) {
      bytes += 2;
      for (const [key, item] of Object.entries(value)) {
        bytes += jsonStringBytes(key) + 2;
        pending.push(item);
      }
    } else {
      bytes += 8;
    }
  }
  return bytes;
}
