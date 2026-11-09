/**
 * Reads an Airtable base through Airtable's Web API, with a personal
 * access token its owner gives: the schema (`schema.bases:read`), then
 * every table's records (`data.records:read`), five requests a second at
 * most, as Airtable allows. Over HTTPS to api.airtable.com only, its
 * certificate verified; the token is never logged nor kept.
 */
import {
  AppError,
  type AirtableRecord,
  type AirtableTable,
  MAX_SNAPSHOT_ROWS,
} from "@anygriddb/core";
import { z } from "zod";

const API = "https://api.airtable.com/v0";
/** Airtable allows five requests a second for a base. */
const SPACING_MS = 220;
const TIMEOUT_MS = 30_000;
/** After a 429, Airtable asks for 30 seconds. */
const RETRY_MS = 30_000;
const RETRIES = 3;

const fieldSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(255),
  type: z.string().max(64),
  description: z.string().max(20_000).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const metaSchema = z.object({
  tables: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().max(255),
        description: z.string().max(20_000).optional(),
        primaryFieldId: z.string().min(1).max(64),
        fields: z.array(fieldSchema).max(500),
        views: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              name: z.string().max(255),
              type: z.string().max(64),
            }),
          )
          .max(500)
          .default([]),
      }),
    )
    .max(500),
});

const pageSchema = z.object({
  records: z.array(
    z.object({
      id: z.string().min(1).max(64),
      createdTime: z.string().max(40).optional(),
      fields: z.record(z.string(), z.unknown()),
    }),
  ),
  offset: z.string().max(200).optional(),
});

export type AirtableBase = {
  tables: AirtableTable[];
  records: Map<string, AirtableRecord[]>;
};

type Fetch = typeof fetch;

/** One GET, spaced and retried as Airtable asks, its error named. */
function client(
  token: string,
  fetcher: Fetch,
  wait: (ms: number) => Promise<void>,
) {
  let last = 0;
  return async function get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const gap = last + SPACING_MS - Date.now();
      if (gap > 0) await wait(gap);
      last = Date.now();
      let response: Response;
      try {
        response = await fetcher(`${API}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new AppError("airtable_failed");
      }
      if (response.status === 429 && attempt < RETRIES) {
        await wait(RETRY_MS);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError("airtable_unauthorized");
      }
      if (response.status === 404)
        throw new AppError("airtable_base_not_found");
      if (!response.ok) {
        throw new AppError("airtable_failed", String(response.status));
      }
      return response.json();
    }
  };
}

/**
 * The base's tables and records. `onProgress` hears each table read, and
 * a base past the snapshot's row limit stops early.
 */
export async function readAirtableBase(
  token: string,
  baseId: string,
  options: {
    onProgress?: (done: number, total: number) => Promise<void>;
    fetcher?: Fetch;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<AirtableBase> {
  const get = client(
    token,
    options.fetcher ?? fetch,
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  const meta = metaSchema.parse(await get(`/meta/bases/${baseId}/tables`));
  const tables: AirtableTable[] = meta.tables;
  const records = new Map<string, AirtableRecord[]>();
  let total = 0;
  for (const [index, table] of tables.entries()) {
    const rows: AirtableRecord[] = [];
    let offset: string | undefined;
    do {
      const query = new URLSearchParams({
        pageSize: "100",
        returnFieldsByFieldId: "true",
      });
      if (offset) query.set("offset", offset);
      const page = pageSchema.parse(
        await get(
          `/${baseId}/${encodeURIComponent(table.id)}?${query.toString()}`,
        ),
      );
      rows.push(...page.records);
      total += page.records.length;
      if (total > MAX_SNAPSHOT_ROWS) throw new AppError("too_many_rows");
      offset = page.offset;
    } while (offset);
    records.set(table.id, rows);
    await options.onProgress?.(index + 1, tables.length);
  }
  return { tables, records };
}
