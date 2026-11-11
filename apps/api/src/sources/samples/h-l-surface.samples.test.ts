/**
 * Suites H–L (API surface): export refusal paths, import refusal on external,
 * Northwind/DVD expose+read, and fields added to a client table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "../../data/engine.js";
import { readPage } from "../../data/rows.js";
import { addColumn } from "../../data/schema-ops.js";
import { sampleWorld, type SampleWorld } from "./engines.js";
import { SAMPLE_ENGINES_WITH_NORTHWIND } from "./types.js";
import {
  closeSampleControl,
  need,
  declareSource,
  exposeChinook,
  exposeNorthwind,
  openSampleControl,
  sourceTables,
  type SampleControl,
} from "./harness.js";

describe("samples H–L surface and native regression", () => {
  let world: SampleWorld;
  let control: SampleControl;

  beforeAll(async () => {
    world = sampleWorld();
    control = await openSampleControl("samples_hl");
  }, 1_800_000);

  afterAll(async () => {
    await closeSampleControl(control);
  });

  it.each(SAMPLE_ENGINES_WITH_NORTHWIND)(
    "H Northwind expose and page on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      const declared = await declareSource(
        control,
        endpoint,
        need(endpoint.northwindDatabase, "northwind database"),
        `Northwind surface ${engine}`,
      );
      const tables = await exposeNorthwind(control, declared);
      const first = need(Object.values(tables)[0], "Northwind table");
      const { engine: catalog } = await loadEngine(
        control.db,
        first,
        () => true,
      );
      const page = await readPage(
        control.db,
        catalog,
        { limit: 20, offset: 0, timeZone: "UTC" },
        { total: true },
      );
      expect(page.rows.length).toBeGreaterThan(0);
    },
  );

  it.each(["mysql", "mariadb"] as const)(
    "H Sakila film page on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      const declared = await declareSource(
        control,
        endpoint,
        need(endpoint.dvdDatabase, "dvd database"),
        `Sakila surface ${engine}`,
      );
      const listed = await sourceTables(control.deps, declared.sourceId);
      const film = need(
        listed.find((t) => t.name.toLowerCase() === "film"),
        "film",
      );
      const { exposeTables } = await import("../expose.js");
      const { tableIds } = await exposeTables(control.deps, control.actorId, {
        sourceId: declared.sourceId,
        baseId: control.baseId,
        tables: [{ schema: film.schema, name: film.name }],
      });
      const { engine: catalog } = await loadEngine(
        control.db,
        need(tableIds[0], "table"),
        () => true,
      );
      const page = await readPage(
        control.db,
        catalog,
        { limit: 25, offset: 0, timeZone: "UTC" },
        { total: false },
      );
      expect(page.rows).toHaveLength(25);
    },
  );

  it("H Pagila film page on postgres", async () => {
    const endpoint = need(
      world.endpoints.find((e) => e.engine === "postgres"),
      "endpoint",
    );
    const declared = await declareSource(
      control,
      endpoint,
      need(endpoint.dvdDatabase, "dvd database"),
      "Pagila surface",
    );
    const listed = await sourceTables(control.deps, declared.sourceId);
    const film = need(
      listed.find((t) => t.name.toLowerCase() === "film"),
      "film",
    );
    const { exposeTables } = await import("../expose.js");
    const { tableIds } = await exposeTables(control.deps, control.actorId, {
      sourceId: declared.sourceId,
      baseId: control.baseId,
      tables: [{ schema: film.schema, name: film.name }],
    });
    const { engine: catalog } = await loadEngine(
      control.db,
      need(tableIds[0], "table"),
      () => true,
    );
    const page = await readPage(
      control.db,
      catalog,
      { limit: 25, offset: 0, timeZone: "UTC" },
      { total: false },
    );
    expect(page.rows).toHaveLength(25);
  });

  it("D17 adding a stored native-style column to external is refused or side-only", async () => {
    const endpoint = need(world.endpoints[0], "endpoint");
    const declared = await declareSource(
      control,
      endpoint,
      endpoint.chinookDatabase,
      "Chinook refuse ddl",
    );
    const tables = await exposeChinook(control, declared);
    // Number fields become side columns (ADR 0032), not client DDL.
    const side = await addColumn(
      control.db,
      control.actorId,
      need(tables.track, "track"),
      {
        label: "notes_side",
        fieldType: "text",
      },
    );
    const { engine } = await loadEngine(
      control.db,
      need(tables.track, "track"),
      () => true,
    );
    const col = engine.table.columns.find((c) => c.name === side.name);
    expect(col?.physical?.side).toBe(true);
  });
});
