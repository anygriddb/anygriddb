#!/usr/bin/env node
/**
 * Print the Admin → Sources values for the lab engines (manual UI setup).
 * Automated registration against a live instance can call the same admin
 * tRPC procedures the e2e sources parcours uses once the API is up.
 */
// Never printed: the person types it from where it is set.
const password = process.env.LAB_PASSWORD
  ? "the value of LAB_PASSWORD"
  : "the lab account's password (default in scripts/lab/grants.sh)";
const host = process.env.ANYGRIDDB_LAB_HOST ?? "127.0.0.1";

const sources = [
  {
    name: "Lab PostgreSQL Chinook",
    engine: "postgres",
    host,
    port: 55432,
    database: "chinook",
    username: "anygriddb",
    password,
    sideSchema: "anygriddb_side",
  },
  {
    name: "Lab MySQL Chinook",
    engine: "mysql",
    host,
    port: 53306,
    database: "Chinook",
    username: "anygriddb",
    password,
    sideSchema: "ag_side",
  },
  {
    name: "Lab MariaDB Chinook",
    engine: "mariadb",
    host,
    port: 53307,
    database: "Chinook",
    username: "anygriddb",
    password,
    sideSchema: "ag_side",
  },
  {
    name: "Lab SQL Server Chinook",
    engine: "sqlserver",
    host,
    port: 51433,
    database: "Chinook",
    username: "anygriddb",
    password,
    sideSchema: "anygriddb_side",
  },
  {
    name: "Lab Oracle Chinook",
    engine: "oracle",
    host,
    port: 52484,
    database: "FREEPDB1",
    username: "anygriddb",
    password,
    sideSchema: "ANYGRIDDB",
  },
];

console.log(
  JSON.stringify(
    {
      hint: "Allow 127.0.0.1 in ANYGRIDDB_SOURCES_ALLOWED_HOSTS, then create these sources in Admin → Sources, pasting docker/lab/certs/ca.crt as each one's CA (the lab speaks TLS only).",
      sources,
    },
    null,
    2,
  ),
);
