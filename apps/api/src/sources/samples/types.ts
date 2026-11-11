/** Engines exercised by the real-sample suites. */
export type SampleEngine =
  "postgres" | "mysql" | "mariadb" | "sqlserver" | "oracle";

/** Every client engine the Chinook suites run on. */
export const SAMPLE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "oracle",
] as const satisfies readonly SampleEngine[];

/** Engines that carry a Northwind seed in the lab. */
export const SAMPLE_ENGINES_WITH_NORTHWIND = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
] as const satisfies readonly SampleEngine[];

export type SampleEndpoint = {
  engine: SampleEngine;
  host: string;
  port: number;
  /**
   * Chinook database name as the engine spells it, or Oracle's service
   * name (`FREEPDB1`) — Oracle has no separate database per sample.
   */
  chinookDatabase: string;
  chinookSchema: string;
  /** Null when the lab has no Northwind for this engine (Oracle). */
  northwindDatabase: string | null;
  northwindSchema: string | null;
  /** Sakila (MySQL/MariaDB), Pagila (Postgres), or null. */
  dvdDatabase: string | null;
  dvdSchema: string | null;
  /** AdventureWorks on SQL Server when loaded. */
  adventureWorksDatabase: string | null;
  username: string;
  password: string;
  /**
   * Side schema (Postgres/SQL Server), database (MySQL/MariaDB), or the
   * reader's own schema on Oracle (ADR 0047).
   */
  sideSchema: string;
};
