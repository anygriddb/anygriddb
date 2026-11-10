/**
 * Control-plane enrichment filters (ADR 0046): resolve matching row ids in
 * PostgreSQL, then constrain the client read. Client SQL must not keep those
 * conditions (they compile against null literals).
 *
 * Inclusion (`is`, `is_not_empty`) sets `rowIds`. Exclusion (`is_empty`,
 * `is_not`) sets `excludeRowIds` so rows without a bag still count as blank.
 */
import {
  AppError,
  isFilterGroup,
  MAX_READ_LIMIT,
  type EngineCatalog,
  type FilterCondition,
  type FilterGroup,
  type ReadSpec,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { enrichmentKeysMatching } from "./enrichment-values.js";

function controlPlaneByName(
  engine: EngineCatalog,
): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  for (const column of engine.table.columns) {
    if (column.physical?.controlPlane === true) {
      out.set(column.name, { id: column.id, name: column.name });
    }
  }
  return out;
}

/** True when any control-plane leaf sits under an OR group. */
function controlPlaneUnderOr(
  group: FilterGroup,
  isCp: (name: string) => boolean,
  underOr = false,
): boolean {
  for (const node of group.conditions) {
    if (isFilterGroup(node)) {
      if (
        controlPlaneUnderOr(node, isCp, underOr || node.conjunction === "or")
      ) {
        return true;
      }
    } else if (isCp(node.column) && (underOr || group.conjunction === "or")) {
      return true;
    }
  }
  return false;
}

/**
 * Drop control-plane leaves; collect them. Nested empty groups are pruned.
 */
export function stripControlPlaneFilter(
  group: FilterGroup | undefined,
  isCp: (name: string) => boolean,
): { filter: FilterGroup | undefined; removed: FilterCondition[] } {
  const removed: FilterCondition[] = [];
  if (!group) return { filter: undefined, removed };

  const walk = (node: FilterGroup): FilterGroup | undefined => {
    const conditions: FilterGroup["conditions"] = [];
    for (const child of node.conditions) {
      if (isFilterGroup(child)) {
        const inner = walk(child);
        if (inner && inner.conditions.length > 0) conditions.push(inner);
      } else if (isCp(child.column)) {
        removed.push(child);
      } else {
        conditions.push(child);
      }
    }
    if (conditions.length === 0) return undefined;
    return { conjunction: node.conjunction, conditions };
  };

  return { filter: walk(group), removed };
}

/**
 * A view's filter as its client query compiles it: the leaves on fields
 * kept in AnyGridDB are checked (AND only, equality or emptiness), then
 * left out, since a read resolves them apart. Colour rules, evaluated in
 * the browser on the merged rows, only leave them out.
 */
export function clientFilter(
  engine: EngineCatalog,
  filter: FilterGroup | undefined,
  options: { check: boolean } = { check: true },
): FilterGroup | undefined {
  const byName = controlPlaneByName(engine);
  if (byName.size === 0 || !filter) return filter;
  const isCp = (name: string) => byName.has(name);
  if (options.check && controlPlaneUnderOr(filter, isCp)) {
    throw new AppError("control_plane_filter");
  }
  const { filter: rest, removed } = stripControlPlaneFilter(filter, isCp);
  if (options.check) {
    for (const condition of removed) {
      enrichmentMatchFromCondition(condition, condition.column);
    }
  }
  return rest;
}

export function enrichmentMatchFromCondition(
  condition: FilterCondition,
  fieldId: string,
): { fieldId: string; match: Parameters<typeof enrichmentKeysMatching>[3] } {
  switch (condition.op) {
    case "is":
      return {
        fieldId,
        match: { op: "eq", value: condition.value },
      };
    case "is_not":
      return {
        fieldId,
        match: { op: "not_eq", value: condition.value },
      };
    case "is_empty":
      return { fieldId, match: { op: "blank" } };
    case "is_not_empty":
      return { fieldId, match: { op: "not_blank" } };
    default:
      throw new AppError("control_plane_filter");
  }
}

export function intersectRowIds(
  existing: readonly string[] | undefined,
  resolved: readonly string[],
): string[] {
  if (!existing) return [...resolved];
  const want = new Set(resolved);
  return existing.filter((id) => want.has(id));
}

export function unionRowIds(
  existing: readonly string[],
  extra: readonly string[],
): string[] {
  const out = new Set(existing);
  for (const id of extra) out.add(id);
  return [...out];
}

/** Whether this match must be applied as exclusion of the positive set. */
export function enrichmentMatchIsExclusion(
  match: Parameters<typeof enrichmentKeysMatching>[3],
): boolean {
  return match.op === "blank" || match.op === "not_eq";
}

/** Positive opposite used to build an exclusion list. */
export function enrichmentExclusionSource(
  match: Parameters<typeof enrichmentKeysMatching>[3],
): Parameters<typeof enrichmentKeysMatching>[3] {
  if (match.op === "blank") return { op: "not_blank" };
  if (match.op === "not_eq") return { op: "eq", value: match.value };
  return match;
}

/**
 * Rewrite a live external read so control-plane filters become `rowIds`
 * and/or `excludeRowIds`. Returns null when the resolved key set is empty.
 */
export async function applyControlPlaneReadSpec(
  db: Database,
  engine: EngineCatalog,
  spec: ReadSpec,
): Promise<ReadSpec | null> {
  const byName = controlPlaneByName(engine);
  if (byName.size === 0 || !spec.filter) return spec;

  const isCp = (name: string) => byName.has(name);
  if (controlPlaneUnderOr(spec.filter, isCp)) {
    throw new AppError("control_plane_filter");
  }

  const { filter, removed } = stripControlPlaneFilter(spec.filter, isCp);
  if (removed.length === 0) return spec;

  let include: string[] | undefined;
  let exclude: string[] = [...(spec.excludeRowIds ?? [])];

  for (const condition of removed) {
    const column = byName.get(condition.column);
    if (!column) continue;
    const { fieldId, match } = enrichmentMatchFromCondition(
      condition,
      column.id,
    );
    if (enrichmentMatchIsExclusion(match)) {
      const positive = await enrichmentKeysMatching(
        db,
        engine.table.id,
        fieldId,
        enrichmentExclusionSource(match),
        MAX_READ_LIMIT,
      );
      exclude = unionRowIds(exclude, positive);
      if (exclude.length > MAX_READ_LIMIT) {
        throw new AppError("control_plane_filter_broad");
      }
      continue;
    }
    const found = await enrichmentKeysMatching(
      db,
      engine.table.id,
      fieldId,
      match,
      MAX_READ_LIMIT,
    );
    include = include === undefined ? found : intersectRowIds(include, found);
    if (include.length === 0) return null;
  }

  const excluded = new Set(exclude);
  if (include !== undefined) {
    const kept = include.filter((id) => !excluded.has(id));
    const final = intersectRowIds(spec.rowIds, kept);
    if (final.length === 0) return null;
    if (final.length > MAX_READ_LIMIT) {
      throw new AppError("control_plane_filter_broad");
    }
    const next: ReadSpec = { ...spec, rowIds: final };
    delete next.excludeRowIds;
    if (filter) next.filter = filter;
    else delete next.filter;
    return next;
  }

  if (spec.rowIds) {
    const final = spec.rowIds.filter((id) => !excluded.has(id));
    if (final.length === 0) return null;
    const next: ReadSpec = { ...spec, rowIds: final };
    delete next.excludeRowIds;
    if (filter) next.filter = filter;
    else delete next.filter;
    return next;
  }

  const next: ReadSpec = { ...spec };
  if (exclude.length > 0) next.excludeRowIds = exclude;
  else delete next.excludeRowIds;
  if (filter) next.filter = filter;
  else delete next.filter;
  return next;
}
