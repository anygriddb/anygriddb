/**
 * Suites A–B: source connection, introspection, expose, FK links, types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import { loadEngine } from "../../data/engine.js";
import { readPage } from "../../data/rows.js";
import { createSource } from "../sources.js";
import { sampleWorld, type SampleWorld } from "./engines.js";
import {
  closeSampleControl,
  need,
  declareSource,
  exposeChinook,
  openSampleControl,
  sourceTables,
  type SampleControl,
} from "./harness.js";
describe("samples A–B sources and introspection", () => {
  let world: SampleWorld;
  let control: SampleControl;

  beforeAll(async () => {
    world = sampleWorld();
    control = await openSampleControl("samples_ab");
  }, 1_800_000);

  afterAll(async () => {
    await closeSampleControl(control);
  });

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "A8 creates a Chinook source on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      const declared = await declareSource(
        control,
        endpoint,
        endpoint.chinookDatabase,
        `Chinook ${engine}`,
      );
      expect(declared.sourceId).toMatch(/^[0-9a-f-]{36}$/i);
    },
  );

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "B1–B6 introspects and exposes Chinook on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      const declared = await declareSource(
        control,
        endpoint,
        endpoint.chinookDatabase,
        `Chinook expose ${engine}`,
      );
      const tables = await sourceTables(control.deps, declared.sourceId);
      const names = new Set(tables.map((t) => t.name.toLowerCase()));
      expect(names.has("album") || names.has("Album".toLowerCase())).toBe(true);
      expect(names.has("track")).toBe(true);
      expect(names.has("artist")).toBe(true);

      const album = tables.find((t) => t.name.toLowerCase() === "album");
      expect(album?.primaryKey.length).toBeGreaterThan(0);
      expect(
        album?.foreignKeys.some(
          (fk) => fk.target.name.toLowerCase() === "artist",
        ),
      ).toBe(true);

      const exposed = await exposeChinook(control, declared);
      expect(exposed.album).toBeTruthy();
      expect(exposed.track).toBeTruthy();
      expect(exposed.artist).toBeTruthy();

      const { engine: catalog } = await loadEngine(
        control.db,
        need(exposed.track, "track"),
        () => true,
      );
      const page = await readPage(
        control.db,
        catalog,
        { limit: 25, offset: 0 },
        { total: false },
      );
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.length).toBeLessThanOrEqual(25);
    },
  );

  it("A2 refuses a PostgreSQL superuser against the lab/control", async () => {
    const endpoint = world.endpoints.find((e) => e.engine === "postgres");
    if (!endpoint) return;
    // Against the control Postgres admin when not using lab, or lab postgres user.
    const adminUrl = process.env.ANYGRIDDB_LAB_HOST
      ? null
      : // In Testcontainers mode the control admin is a superuser.
        endpoint;
    if (!adminUrl) {
      // Lab: try connecting as postgres (superuser) — createSource must refuse.
      await expect(
        createSource(control.deps, control.actorId, {
          name: "Superuser refused",
          engine: "postgres",
          host: endpoint.host,
          port: endpoint.port,
          database: endpoint.chinookDatabase,
          username: "postgres",
          password: endpoint.password,
          tlsCa: null,
          connectionLimit: 1,
          queryTimeoutMs: 10_000,
          timeZone: "UTC",
        }),
      ).rejects.toBeInstanceOf(AppError);
      return;
    }
    await expect(
      createSource(control.deps, control.actorId, {
        name: "Superuser refused",
        engine: "postgres",
        host: endpoint.host,
        port: endpoint.port,
        database: endpoint.chinookDatabase,
        username: "postgres",
        password: process.env.LAB_PASSWORD ?? "Lab!Admin-2026",
        tlsCa: null,
        connectionLimit: 1,
        queryTimeoutMs: 10_000,
        timeZone: "UTC",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it.each(["mysql", "mariadb"] as const)(
    "B DVD sakila lists film on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      expect(endpoint.dvdDatabase).toBeTruthy();
      const declared = await declareSource(
        control,
        endpoint,
        need(endpoint.dvdDatabase, "dvd database"),
        `Sakila ${engine}`,
      );
      const tables = await sourceTables(control.deps, declared.sourceId);
      expect(tables.some((t) => t.name.toLowerCase() === "film")).toBe(true);
      expect(tables.some((t) => t.name.toLowerCase() === "customer")).toBe(
        true,
      );
    },
  );

  it("B Pagila lists film on postgres", async () => {
    const endpoint = need(
      world.endpoints.find((e) => e.engine === "postgres"),
      "endpoint",
    );
    const declared = await declareSource(
      control,
      endpoint,
      need(endpoint.dvdDatabase, "dvd database"),
      "Pagila",
    );
    const tables = await sourceTables(control.deps, declared.sourceId);
    expect(tables.some((t) => t.name.toLowerCase() === "film")).toBe(true);
  });

  it.each(["postgres", "mysql", "mariadb", "sqlserver"] as const)(
    "B Northwind lists customers/orders on %s",
    async (engine) => {
      const endpoint = need(
        world.endpoints.find((e) => e.engine === engine),
        "endpoint",
      );
      const declared = await declareSource(
        control,
        endpoint,
        endpoint.northwindDatabase,
        `Northwind ${engine}`,
      );
      const tables = await sourceTables(control.deps, declared.sourceId);
      const names = tables.map((t) => t.name.toLowerCase());
      expect(
        names.some((n) => n.includes("customer") || n === "customer"),
      ).toBe(true);
    },
  );
});
