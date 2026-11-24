/**
 * Shared catalogs for freezing field-type SQL and (later) responses: one
 * column of every FieldType on a native table, and every side-eligible
 * type on each client dialect.
 */
import { FIELD_TYPES, type FieldType } from "../field-types";
import type { DialectName } from "./dialect";
import type { EngineCatalog, EngineColumn, EngineTable } from "./engine";
import {
  SIDE_FIELD_TYPES,
  sideColumnType,
  type SideFieldType,
} from "./external-write";

const FREEZE_TABLE_ID = "00000000-0000-4000-8000-00000000ft01";
const FREEZE_LINK_ID = "00000000-0000-4000-8000-00000000ft02";

export const FREEZE_DIALECTS: readonly DialectName[] = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "oracle",
];

const linkTable: EngineTable = {
  id: FREEZE_LINK_ID,
  storage: "native",
  physicalName: "t_ft_link",
  primaryColumn: "name",
  columns: [
    { id: "l1", name: "name", label: "Name", fieldType: "text", config: {} },
  ],
};

function columnOf(type: FieldType, index: number): EngineColumn {
  const name = `c_${type}`;
  const base: EngineColumn = {
    id: `f${String(index)}`,
    name,
    label: type,
    fieldType: type,
    config: {},
  };
  switch (type) {
    case "single_select":
    case "multi_select":
      return {
        ...base,
        config: { options: [{ name: "Open", color: "green" }] },
      };
    case "formula":
      return { ...base, config: { expr: { op: "str", value: "x" } } };
    case "lookup":
      return {
        ...base,
        config: { relation: "link", target: "name" },
      };
    case "rollup":
      return {
        ...base,
        config: { relation: "link", target: "name", fn: "count" },
      };
    case "relation_one_to_many":
      return {
        ...base,
        relation: {
          kind: "one_to_many",
          direction: "forward",
          targetTableId: FREEZE_LINK_ID,
          fkColumn: name,
        },
      };
    case "relation_many_to_many":
      return {
        ...base,
        relation: {
          kind: "many_to_many",
          direction: "forward",
          targetTableId: FREEZE_LINK_ID,
          junction: "j_ft",
        },
      };
    case "rating":
      return { ...base, config: { ratingMax: 5 } };
    default:
      return base;
  }
}

/** Native catalog: every FieldType, plus a `link` column for lookup/rollup. */
export function freezeNativeCatalog(): EngineCatalog {
  const columns = FIELD_TYPES.map((type, index) => columnOf(type, index));
  columns.push({
    id: "link",
    name: "link",
    label: "Link",
    fieldType: "relation_one_to_many",
    config: {},
    relation: {
      kind: "one_to_many",
      direction: "forward",
      targetTableId: FREEZE_LINK_ID,
      fkColumn: "link",
    },
  });
  const table: EngineTable = {
    id: FREEZE_TABLE_ID,
    storage: "native",
    physicalName: "t_ft_all",
    primaryColumn: "c_text",
    columns,
  };
  return {
    table,
    tables: new Map([
      [FREEZE_TABLE_ID, table],
      [FREEZE_LINK_ID, linkTable],
    ]),
    readable: () => true,
  };
}

/** Client catalog: every side-eligible type, stored as that engine keeps it. */
export function freezeExternalCatalog(dialect: DialectName): EngineCatalog {
  const columns: EngineColumn[] = SIDE_FIELD_TYPES.map((type, index) =>
    sideColumn(dialect, type, index),
  );
  const pkType =
    dialect === "oracle"
      ? "varchar2(36)"
      : dialect === "sqlserver"
        ? "nvarchar(36)"
        : "varchar(36)";
  const table: EngineTable = {
    id: FREEZE_TABLE_ID,
    storage: "external",
    physicalName: "x_ft",
    primaryColumn: "c_text",
    external: {
      sourceId: "s",
      dialect,
      schema: "app",
      name: "ft",
      key: ["id"],
    },
    columns: [
      {
        id: "pk",
        name: "id",
        label: "Id",
        fieldType: "text",
        config: {},
        physical: { name: "id", type: pkType, zone: "UTC" },
      },
      ...columns,
    ],
  };
  return {
    table,
    tables: new Map([[FREEZE_TABLE_ID, table]]),
    readable: () => true,
  };
}

function sideColumn(
  dialect: DialectName,
  type: SideFieldType,
  index: number,
): EngineColumn {
  return {
    id: `s${String(index)}`,
    name: `c_${type}`,
    label: type,
    fieldType: type,
    config:
      type === "single_select"
        ? { options: [{ name: "Open", color: "green" }] }
        : type === "rating"
          ? { ratingMax: 5 }
          : {},
    physical: {
      name: `c_${type}`,
      type: sideColumnType(dialect, type),
      zone: "UTC",
    },
  };
}

export { FIELD_TYPES, SIDE_FIELD_TYPES };
