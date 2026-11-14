/**
 * Where the sample engines listen, and the account the suites read with.
 * Pure data, shared by the global setup and the suites.
 */
import type { SampleEndpoint, SampleEngine } from "./types.js";

const READER = "anygriddb";

/** The lab's one password: root, sa, system, and the reader account share it. */
export const LAB_PASSWORD = process.env.LAB_PASSWORD ?? "Lab!Admin-2026";

type EnginePorts = Record<SampleEngine, number>;

/** The host ports docker/lab/compose.yml publishes. */
export const LAB_PORTS: EnginePorts = {
  postgres: 55432,
  mysql: 53306,
  mariadb: 53307,
  sqlserver: 51433,
  /** TCPS front (`aglab-oracle-tls`); seed/sqlplus uses 51521. */
  oracle: 52484,
};

export function sampleEndpoints(
  host: string,
  ports: EnginePorts,
  options: { adventureWorks: boolean },
): SampleEndpoint[] {
  const account = { host, username: READER, password: LAB_PASSWORD };
  const mysqlLike = (engine: "mysql" | "mariadb"): SampleEndpoint => ({
    ...account,
    engine,
    port: ports[engine],
    chinookDatabase: "Chinook",
    chinookSchema: "Chinook",
    northwindDatabase: "northwind",
    northwindSchema: "northwind",
    dvdDatabase: "sakila",
    dvdSchema: "sakila",
    adventureWorksDatabase: null,
    sideSchema: "ag_side",
  });
  return [
    {
      ...account,
      engine: "postgres",
      port: ports.postgres,
      chinookDatabase: "chinook",
      chinookSchema: "public",
      northwindDatabase: "northwind",
      northwindSchema: "public",
      dvdDatabase: "pagila",
      dvdSchema: "public",
      adventureWorksDatabase: null,
      sideSchema: "anygriddb_side",
    },
    mysqlLike("mysql"),
    mysqlLike("mariadb"),
    {
      ...account,
      engine: "sqlserver",
      port: ports.sqlserver,
      chinookDatabase: "Chinook",
      chinookSchema: "dbo",
      northwindDatabase: "northwind",
      northwindSchema: "dbo",
      dvdDatabase: null,
      dvdSchema: null,
      adventureWorksDatabase: options.adventureWorks
        ? "AdventureWorks2022"
        : null,
      sideSchema: "anygriddb_side",
    },
    {
      ...account,
      engine: "oracle",
      port: ports.oracle,
      chinookDatabase: "FREEPDB1",
      chinookSchema: "CHINOOK",
      northwindDatabase: null,
      northwindSchema: null,
      dvdDatabase: null,
      dvdSchema: null,
      adventureWorksDatabase: null,
      // Side tables live in the reader's own schema (ADR 0047).
      sideSchema: "ANYGRIDDB",
    },
  ];
}
