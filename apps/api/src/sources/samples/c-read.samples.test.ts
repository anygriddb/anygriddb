/**
 * Suite C: read engine on Chinook — paging, filters, sort, group, formulas,
 * lookups, ACL, limit bound.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineCatalog } from "@anygriddb/core";
import { loadEngine } from "../../data/engine.js";
import { aggregateRows, readPage, visibleFields } from "../../data/rows.js";
import { addColumn } from "../../data/schema-ops.js";
import { insertComputed } from "../../data/computed.js";
import { readerEngine, setTableAcl } from "../../data/acl.js";
import { withAudit } from "../../data/audit-context.js";
import { sampleWorld, type SampleWorld } from "./engines.js";
import { SAMPLE_ENGINES } from "./types.js";
import {
  closeSampleControl,
  need,
  declareSource,
  exposeChinook,
  openSampleControl,
  type SampleControl,
} from "./harness.js";

/** A cell read as text: a string as it is, anything else empty. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function physical(engine: EngineCatalog, name: string): string {
  const column = engine.table.columns.find(
    (item) => item.physical?.name.toLowerCase() === name.toLowerCase(),
  );
  if (!column) throw new Error(`no physical field ${name}`);
  return column.name;
}

describe("samples C read engine on Chinook", () => {
  let world: SampleWorld;
  let control: SampleControl;
  const exposedByEngine = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    world = sampleWorld();
    control = await openSampleControl("samples_c");
    for (const endpoint of world.endpoints) {
      const declared = await declareSource(
        control,
        endpoint,
        endpoint.chinookDatabase,
        `Chinook read ${endpoint.engine}`,
      );
      exposedByEngine.set(
        endpoint.engine,
        await exposeChinook(control, declared),
      );
    }
  }, 1_800_000);

  afterAll(async () => {
    await closeSampleControl(control);
  });

  it.each(SAMPLE_ENGINES)(
    "C1 pages Track with limit 100 on %s",
    async (engine) => {
      const trackId = need(exposedByEngine.get(engine)?.track, "track");
      const { engine: catalog } = await loadEngine(
        control.db,
        trackId,
        () => true,
      );
      const page = await readPage(
        control.db,
        catalog,
        { limit: 100, offset: 0, timeZone: "UTC" },
        { total: false },
      );
      expect(page.rows).toHaveLength(100);
    },
  );

  it.each(SAMPLE_ENGINES)(
    "C1 rejects limit above 1000 on %s",
    async (engine) => {
      const trackId = need(exposedByEngine.get(engine)?.track, "track");
      const { engine: catalog } = await loadEngine(
        control.db,
        trackId,
        () => true,
      );
      await expect(
        readPage(
          control.db,
          catalog,
          { limit: 1001, offset: 0, timeZone: "UTC" },
          { total: false },
        ),
      ).rejects.toThrow(/Invalid limit|limit/i);
    },
  );

  it.each(SAMPLE_ENGINES)("C5 sorts Album by title on %s", async (engine) => {
    const albumId = need(exposedByEngine.get(engine)?.album, "album");
    const { engine: catalog } = await loadEngine(
      control.db,
      albumId,
      () => true,
    );
    const title = physical(catalog, "title");
    const page = await readPage(
      control.db,
      catalog,
      {
        limit: 10,
        offset: 0,
        timeZone: "UTC",
        sort: [{ column: title, direction: "asc" }],
      },
      { total: false },
    );
    expect(page.rows.length).toBeGreaterThan(0);
    const titles = page.rows.map((row) => text(row[title]));
    // Sorts follow the source's collation: PostgreSQL's (glibc) passes over
    // spaces and punctuation, the others' do not.
    const collator = new Intl.Collator("en", {
      sensitivity: "base",
      ignorePunctuation: engine === "postgres",
    });
    const sorted = [...titles].sort((a, b) => collator.compare(a, b));
    expect(titles).toEqual(sorted);
  });

  it.each(SAMPLE_ENGINES)(
    "C4 filters Invoice by billing country USA on %s",
    async (engine) => {
      const invoiceId = need(exposedByEngine.get(engine)?.invoice, "invoice");
      const { engine: catalog } = await loadEngine(
        control.db,
        invoiceId,
        () => true,
      );
      const countryCol =
        catalog.table.columns.find((c) =>
          (c.physical?.name ?? c.name).toLowerCase().includes("billingcountry"),
        ) ??
        catalog.table.columns.find((c) =>
          (c.physical?.name ?? c.name)
            .toLowerCase()
            .includes("billing_country"),
        );
      const country = need(countryCol, "billing country").name;
      const page = await readPage(
        control.db,
        catalog,
        {
          limit: 50,
          offset: 0,
          timeZone: "UTC",
          filter: {
            conjunction: "and",
            conditions: [{ column: country, op: "is", value: "USA" }],
          },
        },
        { total: false },
      );
      expect(page.rows.length).toBeGreaterThan(0);
      for (const row of page.rows) {
        expect(row[country]).toBe("USA");
      }
    },
  );

  it.each(SAMPLE_ENGINES)(
    "C6 aggregates Invoice count on %s",
    async (engine) => {
      const invoiceId = need(exposedByEngine.get(engine)?.invoice, "invoice");
      const { engine: catalog } = await loadEngine(
        control.db,
        invoiceId,
        () => true,
      );
      const idCol = catalog.table.columns.find(
        (c) =>
          (c.physical?.name ?? "").toLowerCase().includes("invoiceid") ||
          (c.physical?.name ?? "") === "invoice_id",
      );
      const invoiceKey = need(idCol, "invoice id").name;
      const [count] = await aggregateRows(
        control.db,
        catalog,
        { timeZone: "UTC" },
        [{ column: invoiceKey, fn: "count_all" }],
      );
      expect(Number(count)).toBeGreaterThan(400);
    },
  );

  it.each(SAMPLE_ENGINES)(
    "C7 formula LEN(title) on Album on %s",
    async (engine) => {
      const albumId = need(exposedByEngine.get(engine)?.album, "album");
      const { engine: catalog } = await loadEngine(
        control.db,
        albumId,
        () => true,
      );
      const title = physical(catalog, "title");
      const column = await addColumn(control.db, control.actorId, albumId, {
        label: `title_len_${engine}`,
        fieldType: "formula",
        formulaSource: `LEN({${title}})`,
      });
      const { engine: refreshed } = await loadEngine(
        control.db,
        albumId,
        () => true,
      );
      const page = await readPage(
        control.db,
        refreshed,
        {
          limit: 5,
          offset: 0,
          timeZone: "UTC",
          fields: [title, column.name],
        },
        { total: false },
      );
      expect(page.rows).toHaveLength(5);
      for (const row of page.rows) {
        expect(Number(row[column.name])).toBe(text(row[title]).length);
      }
    },
  );

  it.each(SAMPLE_ENGINES)(
    "C9 lookup Artist name from Album on %s",
    async (engine) => {
      const albumId = need(exposedByEngine.get(engine)?.album, "album");
      const artistId = need(exposedByEngine.get(engine)?.artist, "artist");
      const { engine: albumCat } = await loadEngine(
        control.db,
        albumId,
        () => true,
      );
      // The client's foreign key to Artist, exposed as a link field.
      const link = need(
        albumCat.table.columns.find(
          (c) => c.relation?.targetTableId === artistId,
        ),
        "link to Artist",
      );
      const { engine: artistCat } = await loadEngine(
        control.db,
        artistId,
        () => true,
      );
      const nameCol = physical(artistCat, "name");
      const lookup = await insertComputed(
        control.db,
        control.actorId,
        {
          tableId: albumId,
          label: `artist_name_${engine}`,
          relation: link.name,
          target: nameCol,
        },
        () => true,
      );
      const { engine: refreshed } = await loadEngine(
        control.db,
        albumId,
        () => true,
      );
      const page = await readPage(
        control.db,
        refreshed,
        {
          limit: 5,
          offset: 0,
          timeZone: "UTC",
          fields: [lookup.name],
        },
        { total: false },
      );
      expect(page.rows).toHaveLength(5);
      for (const row of page.rows) {
        // A lookup is a list: here the album's one artist.
        const names: unknown = row[lookup.name];
        expect(Array.isArray(names) ? names.length : 0).toBe(1);
        expect(text((names as unknown[])[0]).length).toBeGreaterThan(0);
      }
    },
  );

  it.each(SAMPLE_ENGINES)(
    "C10 field ACL hides UnitPrice on Track on %s",
    async (engine) => {
      const trackId = need(exposedByEngine.get(engine)?.track, "track");
      const member = (
        await control.db
          .insertInto("users")
          .values({
            email: `member-${engine}@example.com`,
            displayName: "Member",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      await withAudit(
        control.db,
        { userId: control.actorId, source: "web" },
        (tx) =>
          tx
            .insertInto("roleBindings")
            .values({
              userId: member,
              role: "editor",
              scope: "base",
              scopeId: control.baseId,
            })
            .execute(),
      );
      const { engine: catalog } = await loadEngine(
        control.db,
        trackId,
        () => true,
      );
      const price = catalog.table.columns.find(
        (c) =>
          (c.physical?.name ?? "").toLowerCase().includes("unitprice") ||
          (c.physical?.name ?? "") === "unit_price",
      );
      const unitPrice = need(price, "unit price");
      const visible = catalog.table.columns
        .filter((c) => c.id !== unitPrice.id && c.fieldType !== "formula")
        .slice(0, 8)
        .map((c) => ({ column: c.name, access: "read" as const }));
      await setTableAcl(control.db, control.actorId, {
        tableId: trackId,
        userId: member,
        rowFilter: null,
        columns: [...visible, { column: unitPrice.name, access: "hide" }],
      });
      const { engine: reader } = await readerEngine(control.db, trackId, {
        userId: member,
        bindings: [{ role: "editor", scope: "base", scopeId: control.baseId }],
      });
      const fields = visibleFields(reader);
      const page = await readPage(
        control.db,
        reader,
        {
          limit: 5,
          offset: 0,
          timeZone: "UTC",
          ...(fields ? { fields } : {}),
        },
        { total: false },
      );
      expect(page.rows.length).toBeGreaterThan(0);
      expect(unitPrice.name in (page.rows[0] ?? {})).toBe(false);
    },
  );
});
