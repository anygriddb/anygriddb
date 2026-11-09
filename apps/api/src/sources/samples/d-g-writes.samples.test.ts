/**
 * Suites D–G: client writes, side fields, watch config, seals on Chinook.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, type EngineCatalog } from "@anygriddb/core";
import { loadEngine } from "../../data/engine.js";
import { readPage } from "../../data/rows.js";
import { addColumn } from "../../data/schema-ops.js";
import { changeStatus, loadRowScope, updateRows } from "../../services/rows.js";
import { setTableWrites } from "../expose.js";
import { checkSeals } from "../statuses.js";
import { setTableWatch } from "../watch.js";
import { recordingBus } from "../../realtime/recording-bus.test-helpers.js";
import { sampleWorld, type SampleWorld } from "./engines.js";
import {
  closeSampleControl,
  need,
  declareSource,
  exposeChinook,
  openSampleControl,
  type SampleControl,
} from "./harness.js";

function columnOf(engine: EngineCatalog, physical: string): string {
  const column = engine.table.columns.find(
    (item) => item.physical?.name.toLowerCase() === physical.toLowerCase(),
  );
  if (!column) throw new Error(`no field for ${physical}`);
  return column.name;
}

describe("samples D–G writes, side, watch, seals", () => {
  let world: SampleWorld;
  let control: SampleControl;
  const exposedByEngine = new Map<string, Record<string, string>>();
  const services = {
    get db() {
      return control.db;
    },
    bus: recordingBus().bus,
    log: () => undefined,
  };

  beforeAll(async () => {
    world = sampleWorld();
    control = await openSampleControl("samples_dg");
    for (const endpoint of world.endpoints) {
      const declared = await declareSource(
        control,
        endpoint,
        endpoint.chinookDatabase,
        `Chinook write ${endpoint.engine}`,
      );
      const tables = await exposeChinook(control, declared);
      exposedByEngine.set(endpoint.engine, tables);
      if (tables.genre) {
        await setTableWrites(control.deps, control.actorId, {
          tableId: tables.genre,
          update: true,
          insert: false,
          delete: false,
        });
      }
    }
  }, 1_800_000);

  afterAll(async () => {
    await closeSampleControl(control);
  });

  async function scopeOf(tableId: string) {
    const table = await control.db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    return loadRowScope(
      control.db,
      {
        userId: control.actorId,
        bindings: [{ role: "owner", scope: "base", scopeId: control.baseId }],
      },
      table,
    );
  }

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "D5 updates Genre name under compare-lock on %s",
    async (engine) => {
      const genreId = need(exposedByEngine.get(engine)?.genre, "genre");
      let scope = await scopeOf(genreId);
      const name = columnOf(scope.engine, "Name");
      const id = columnOf(
        scope.engine,
        engine === "postgres" ? "genre_id" : "GenreId",
      );
      const page = await readPage(
        control.db,
        scope.engine,
        {
          limit: 1,
          offset: 0,
          timeZone: "UTC",
          sort: [{ column: id, direction: "asc" }],
        },
        { total: false },
      );
      const row = need(page.rows[0], "row");
      const rowId = String(row[id]);
      const previous = typeof row[name] === "string" ? row[name] : "";
      const next = `${previous} · sample`;
      await updateRows(
        services,
        scope,
        [
          {
            rowId,
            values: { [name]: next },
            expected: { [name]: previous },
          },
        ],
        { source: "web" },
      );
      scope = await scopeOf(genreId);
      const check = await readPage(
        control.db,
        scope.engine,
        {
          limit: 1,
          offset: 0,
          timeZone: "UTC",
          rowIds: [rowId],
        },
        { total: false },
      );
      expect(check.rows[0]?.[name]).toBe(next);
      await updateRows(
        services,
        scope,
        [
          {
            rowId,
            values: { [name]: previous },
            expected: { [name]: next },
          },
        ],
        { source: "web" },
      );
    },
  );

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "D13 refuses Artist write when disabled on %s",
    async (engine) => {
      const artistId = need(exposedByEngine.get(engine)?.artist, "artist");
      const scope = await scopeOf(artistId);
      const name = columnOf(scope.engine, "Name");
      const id = columnOf(
        scope.engine,
        engine === "postgres" ? "artist_id" : "ArtistId",
      );
      const page = await readPage(
        control.db,
        scope.engine,
        { limit: 1, offset: 0, timeZone: "UTC" },
        { total: false },
      );
      const row = need(page.rows[0], "row");
      await expect(
        updateRows(
          services,
          scope,
          [
            {
              rowId: String(row[id]),
              values: { [name]: "nope" },
            },
          ],
          { source: "web" },
        ),
      ).rejects.toBeInstanceOf(AppError);
    },
  );

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "E side number field on Album on %s",
    async (engine) => {
      const albumId = need(exposedByEngine.get(engine)?.album, "album");
      const side = await addColumn(control.db, control.actorId, albumId, {
        label: `score_${engine}`,
        fieldType: "number",
      });
      const { engine: catalog } = await loadEngine(
        control.db,
        albumId,
        () => true,
      );
      const col = catalog.table.columns.find((c) => c.name === side.name);
      expect(col?.physical?.side).toBe(true);
    },
  );

  it.each(["postgres", "mysql", "mariadb"] as const)(
    "F setWatch accepts or refuses Genre on %s",
    async (engine) => {
      const genreId = need(exposedByEngine.get(engine)?.genre, "genre");
      try {
        await setTableWatch(control.deps, control.actorId, {
          tableId: genreId,
          method: "column",
          column: engine === "postgres" ? "name" : "Name",
          intervalSeconds: 30,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
      }
    },
  );

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "G submit then lock Album row on %s",
    async (engine) => {
      const albumId = need(exposedByEngine.get(engine)?.album, "album");
      const scope = await scopeOf(albumId);
      const owner = { ...scope, role: "owner" as const };
      const id = columnOf(
        scope.engine,
        engine === "postgres" ? "album_id" : "AlbumId",
      );
      const page = await readPage(
        control.db,
        scope.engine,
        { limit: 1, offset: 0, timeZone: "UTC" },
        { total: false },
      );
      const rowId = String(need(page.rows[0], "row")[id]);
      await changeStatus(services, owner, rowId, "submitted", {
        source: "web",
      });
      await changeStatus(services, owner, rowId, "locked", { source: "web" });
      // The sealed row is compared with the client's, and found unchanged.
      const checked = await checkSeals(
        { db: control.db, log: () => undefined },
        { tableId: albumId, rowIds: [rowId] },
      );
      expect(checked).toBe(1);
      const state = await control.db
        .selectFrom("externalStatuses")
        .select(["status", "drift"])
        .where("tableId", "=", albumId)
        .where("rowId", "=", rowId)
        .executeTakeFirstOrThrow();
      expect(state.status).toBe("locked");
      expect(state.drift).toBeNull();
    },
  );
});
