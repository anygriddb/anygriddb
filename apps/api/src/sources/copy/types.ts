/**
 * A store that speaks no SQL (ADR 0088). The read engine cannot read it
 * where it lives, so AnyGridDB reads it the one way every store allows:
 * what the account may see, then each table's rows from first to last. The
 * rows go to a copy in AnyGridDB's database (ADR 0034), and every read
 * people make goes there. Nothing is ever written to the store.
 */
import type { SourceCheck, SourceConnection, SourceTable } from "../types.js";

export type ConnectOptions = {
  /** Development only: connect without TLS. */
  allowPlaintext: boolean;
};

/** One value of a row, as JSON carries it: a date as its ISO text. */
export type CopyValue = string | number | boolean | null;

/** A row as its store gave it: `id` names it, its values by field name. */
export type CopyRow = { id: string; values: Record<string, CopyValue> };

/** The table a refresh copies, as the catalog holds it. */
export type CopyRequest = {
  schema: string;
  name: string;
  /** The fields that name a row; empty for a table without a key. */
  key: readonly string[];
  /** The store's fields the copy keeps. */
  fields: readonly string[];
  /** Rows a page holds, at most. */
  pageSize: number;
};

export type CopyConnector = {
  /** Signs in, and refuses an account that administers the store. */
  check(
    source: SourceConnection,
    options: ConnectOptions,
  ): Promise<SourceCheck>;
  /** What the account may read, each field with the type its values have. */
  tables(
    source: SourceConnection,
    options: ConnectOptions,
  ): Promise<SourceTable[]>;
  /**
   * The table's rows, a page at a time. The connection lives as long as
   * the pages are read, and closes when the reader stops, early or not.
   */
  rows(
    source: SourceConnection,
    options: ConnectOptions,
    request: CopyRequest,
  ): AsyncGenerator<CopyRow[], void, void>;
};
