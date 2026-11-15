/**
 * A table built from the values a store's rows actually hold (ADR 0088).
 * Every copy connector describes its fields the same way.
 */
import type { SourceTable } from "../types.js";
import { FieldSample } from "./values.js";

export function tableFromSamples(input: {
  schema: string;
  name: string;
  key: readonly string[];
  samples: ReadonlyMap<string, FieldSample>;
  estimatedRows: number | null;
  kind?: "table" | "view";
}): SourceTable {
  const names = [...input.samples.keys()];
  return {
    schema: input.schema,
    name: input.name,
    kind: input.kind ?? "table",
    comment: null,
    estimatedRows: input.estimatedRows,
    primaryKey: [...input.key],
    privileges: { insert: false, update: false, delete: false },
    columns: names.map((name) => {
      const { type, field } = input.samples.get(name)?.describe() ?? {
        type: "null",
        field: { fieldType: "text" as const, readOnly: false },
      };
      return {
        name,
        type,
        nullable: !input.key.includes(name),
        comment: null,
        canUpdate: false,
        canInsert: false,
        field,
      };
    }),
    foreignKeys: [],
  };
}

/** Remembers a field's values, up to a fixed number of fields. */
export function remember(
  samples: Map<string, FieldSample>,
  name: string,
  kind: Parameters<FieldSample["add"]>[0],
  native: string,
  text?: string,
  limit = 300,
): void {
  if (!samples.has(name) && samples.size >= limit) return;
  const sample = samples.get(name) ?? new FieldSample();
  sample.add(kind, native, text);
  samples.set(name, sample);
}
