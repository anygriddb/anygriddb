/** Engines exercised by the real-sample suites. */
export type SampleEngine = "postgres" | "mysql" | "mariadb" | "sqlserver";

export type SampleEndpoint = {
  engine: SampleEngine;
  host: string;
  port: number;
  /** Chinook database name as the engine spells it. */
  chinookDatabase: string;
  chinookSchema: string;
  northwindDatabase: string;
  northwindSchema: string;
  /** Sakila (MySQL/MariaDB), Pagila (Postgres), or null. */
  dvdDatabase: string | null;
  dvdSchema: string | null;
  /** AdventureWorks on SQL Server when loaded. */
  adventureWorksDatabase: string | null;
  username: string;
  password: string;
  /** Side schema (Postgres/SQL Server) or database (MySQL/MariaDB). */
  sideSchema: string;
};
