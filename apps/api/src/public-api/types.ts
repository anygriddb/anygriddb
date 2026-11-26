import { ceilingOf } from "@anygriddb/core";
import type { Binding } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { Bus } from "../realtime/bus.js";
import type { SessionUser } from "../auth/session.js";
import type { TokenScope } from "../auth/tokens.js";
import type { ReadBudget } from "../read-budget.js";
import { z } from "zod";

export const MAX_RECORDS = ceilingOf("api.records_per_call");

/**
 * A whole number as a query writes one: digits and nothing else. `Number`
 * also reads `0x10`, `1e3` and a padded ` 1`, which the document does not
 * call integers. A number that is one already (a tool's argument) is
 * taken as it is.
 */
function wholeNumber(bounds: { min: number; max: number; fallback: number }) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(bounds.min).max(bounds.max).default(bounds.fallback),
  );
}

/**
 * What a list of records takes in its query. The document's parameters are
 * written from it, so that it cannot say otherwise than the server reads.
 */
export const listQuerySchema = z.object({
  limit: wholeNumber({ min: 1, max: 1000, fallback: 100 }).describe(
    "Records a page",
  ),
  offset: wholeNumber({ min: 0, max: 10_000_000, fallback: 0 }).describe(
    "Records to skip",
  ),
  view: z
    .uuid()
    .optional()
    .describe("A view of the table: its filter, its sort and its fields apply"),
  sort: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Comma list of fields, `-` before one for descending"),
  filter: z
    .string()
    .min(1)
    .max(20_000)
    .optional()
    .describe("JSON filter group with field names"),
  search: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Words to find in the fields that hold text"),
  fields: z
    .string()
    .min(1)
    .max(5_000)
    .optional()
    .describe("Comma list of fields to return"),
  fieldKey: z
    .enum(["name", "label"])
    .default("name")
    .describe("Whether fields are keyed by their name or by their label"),
  timeZone: z
    .string()
    .max(64)
    .optional()
    .describe(
      "IANA time zone a filter's dates are read in; UTC when absent or unknown",
    ),
});

/** What one record takes in its query. */
export const recordQuerySchema = listQuerySchema.pick({ fieldKey: true });

export type PublicApiDeps = {
  db: Database;
  bus: Bus;
  publicUrl: string;
  log: (error: unknown, message: string) => void;
};

/** Who calls: a person, and the token's scope when a token was used. */
export type Actor = {
  user: SessionUser;
  bindings: Binding[];
  scope?: TokenScope;
  /** What this request may hold of the rows it reads (ADR 0110). */
  readBudget?: ReadBudget;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
