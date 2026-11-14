/** What grouping reads of the catalog's bases (`CatalogBase`). */
type CatalogSlice = ReadonlyArray<{
  id: string;
  name: string;
  tables: ReadonlyArray<{
    id: string;
    name: string;
    external: {
      engine: string;
      schema: string;
      name: string;
      source: { id: string; name: string } | null;
    } | null;
  }>;
}>;

type SourceTable = {
  baseId: string;
  baseName: string;
  tableId: string;
  name: string;
  /** The table's name in its database: `schema.name`. */
  stored: string;
};

type SourceGroup = {
  id: string;
  name: string;
  engine: string;
  tables: SourceTable[];
};

/**
 * The databases the person's tables are read from, by the name an
 * administrator gave each one, with those tables: what the catalog
 * already lets them read, grouped by where it lives.
 */
export function sourcesOf(bases: CatalogSlice): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const base of bases) {
    for (const table of base.tables) {
      const source = table.external?.source;
      if (!table.external || !source) continue;
      const group = groups.get(source.id) ?? {
        id: source.id,
        name: source.name,
        engine: table.external.engine,
        tables: [],
      };
      group.tables.push({
        baseId: base.id,
        baseName: base.name,
        tableId: table.id,
        name: table.name,
        stored: `${table.external.schema}.${table.external.name}`,
      });
      groups.set(source.id, group);
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
