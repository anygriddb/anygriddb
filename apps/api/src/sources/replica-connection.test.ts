import { describe, expect, it } from "vitest";
import type { SourceInput } from "@anygriddb/core";
import { replicaConnectionOf } from "./sources.js";

const primary: SourceInput = {
  name: "ERP",
  engine: "postgres",
  host: "db.example",
  port: 5432,
  database: "app",
  username: "reader",
  password: "secret",
  connectionLimit: 5,
  queryTimeoutMs: 15_000,
  timeZone: "UTC",
  tlsCa: null,
};

describe("replicaConnectionOf", () => {
  it("returns null when no replica host is set", () => {
    expect(replicaConnectionOf(primary)).toBeNull();
    expect(replicaConnectionOf({ ...primary, replicaHost: null })).toBeNull();
    expect(replicaConnectionOf({ ...primary, replicaHost: "  " })).toBeNull();
  });

  it("falls back to the primary port, database, user, and password", () => {
    expect(
      replicaConnectionOf({ ...primary, replicaHost: "replica.example" }),
    ).toEqual({
      engine: "postgres",
      host: "replica.example",
      port: 5432,
      database: "app",
      username: "reader",
      password: "secret",
      tlsCa: null,
      queryTimeoutMs: 15_000,
    });
  });

  it("keeps explicit replica credentials and database", () => {
    expect(
      replicaConnectionOf({
        ...primary,
        replicaHost: "replica.example",
        replicaPort: 5433,
        replicaDatabase: "app_ro",
        replicaUsername: "ro",
        replicaPassword: "other",
      }),
    ).toMatchObject({
      host: "replica.example",
      port: 5433,
      database: "app_ro",
      username: "ro",
      password: "other",
    });
  });
});
