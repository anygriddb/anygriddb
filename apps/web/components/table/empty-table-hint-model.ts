/**
 * What an empty grid says under its last line. A table with no row yet
 * says how to start, to those who can start it; a view whose filters or
 * search leave nothing says so, rather than looking like an empty table.
 */
export function emptyTableHint(input: {
  total: number;
  loading: boolean;
  grouped: boolean;
  searched: boolean;
  filtered: boolean;
  canAdd: boolean;
  canImport: boolean;
}): "start" | "nothing-matches" | null {
  if (input.loading || input.total > 0 || input.grouped) return null;
  if (input.searched || input.filtered) return "nothing-matches";
  return input.canAdd || input.canImport ? "start" : null;
}
