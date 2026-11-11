/**
 * Vitest global setup for the sample suites: the five client engines, started
 * and loaded once for every suite.
 *
 * With `ANYGRIDDB_LAB_HOST`, the docker/lab compose serves them over TLS
 * (Oracle through the TCPS front on 52484). Otherwise Testcontainers starts
 * them on the loopback, and `scripts/lab/seed.sh` loads them, so both paths
 * get the same datasets and grants.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import type { TestProject } from "vitest/node";
import { LAB_PASSWORD, LAB_PORTS, sampleEndpoints } from "./endpoints.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const STARTUP_MS = 300_000;
const ORACLE_STARTUP_MS = 600_000;

function postgres(): Promise<StartedTestContainer> {
  return (
    new GenericContainer("postgres:17")
      .withEnvironment({ POSTGRES_PASSWORD: LAB_PASSWORD })
      .withExposedPorts(5432)
      // The entrypoint's init server says it once, the real one a second time.
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(STARTUP_MS)
      .start()
  );
}

function mysql(): Promise<StartedTestContainer> {
  return (
    new GenericContainer("mysql:8.4")
      .withEnvironment({ MYSQL_ROOT_PASSWORD: LAB_PASSWORD })
      .withExposedPorts(3306)
      // TCP answers only once the init server, which skips networking, is gone.
      .withHealthCheck({
        test: [
          "CMD",
          "mysqladmin",
          "ping",
          "-h",
          "127.0.0.1",
          "-uroot",
          `-p${LAB_PASSWORD}`,
        ],
        interval: 2_000,
        timeout: 5_000,
        retries: 90,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .withStartupTimeout(STARTUP_MS)
      .start()
  );
}

function mariadb(): Promise<StartedTestContainer> {
  return new GenericContainer("mariadb:11.4")
    .withEnvironment({ MARIADB_ROOT_PASSWORD: LAB_PASSWORD })
    .withExposedPorts(3306)
    .withHealthCheck({
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
      interval: 2_000,
      timeout: 5_000,
      retries: 90,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(STARTUP_MS)
    .start();
}

function sqlServer(): Promise<StartedTestContainer> {
  return new GenericContainer("mcr.microsoft.com/mssql/server:2022-latest")
    .withEnvironment({
      ACCEPT_EULA: "Y",
      MSSQL_SA_PASSWORD: LAB_PASSWORD,
      MSSQL_PID: "Developer",
    })
    .withExposedPorts(1433)
    .withHealthCheck({
      test: [
        "CMD",
        "/opt/mssql-tools18/bin/sqlcmd",
        "-S",
        "localhost",
        "-U",
        "sa",
        "-P",
        LAB_PASSWORD,
        "-C",
        "-Q",
        "SELECT 1",
      ],
      interval: 3_000,
      timeout: 10_000,
      retries: 90,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(STARTUP_MS)
    .start();
}

function oracle(): Promise<StartedTestContainer> {
  return new GenericContainer("gvenzl/oracle-free:23-slim-faststart")
    .withEnvironment({ ORACLE_PASSWORD: LAB_PASSWORD })
    .withExposedPorts(1521)
    .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/i))
    .withStartupTimeout(ORACLE_STARTUP_MS)
    .start();
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const labHost = process.env.ANYGRIDDB_LAB_HOST?.trim();
  if (labHost) {
    // Every engine is listed: one the lab does not run fails its tests.
    project.provide(
      "sampleEndpoints",
      sampleEndpoints(labHost, LAB_PORTS, { adventureWorks: true }),
    );
    return () => Promise.resolve();
  }

  const started = await Promise.allSettled([
    postgres(),
    mysql(),
    mariadb(),
    sqlServer(),
    oracle(),
  ]);
  const containers = started.flatMap((s) =>
    s.status === "fulfilled" ? [s.value] : [],
  );
  const stop = async () => {
    await Promise.all(containers.map((c) => c.stop()));
  };
  const failed = started.find((s) => s.status === "rejected");
  if (failed) {
    await stop();
    throw failed.reason;
  }
  const [pg, my, maria, mssql, ora] = containers as [
    StartedTestContainer,
    StartedTestContainer,
    StartedTestContainer,
    StartedTestContainer,
    StartedTestContainer,
  ];

  try {
    execFileSync("bash", [join(repoRoot, "scripts/lab/seed.sh")], {
      env: {
        ...process.env,
        LAB_PASSWORD,
        LAB_PG_CONTAINER: pg.getId(),
        LAB_MYSQL_CONTAINER: my.getId(),
        LAB_MARIADB_CONTAINER: maria.getId(),
        LAB_MSSQL_CONTAINER: mssql.getId(),
        LAB_ORACLE_CONTAINER: ora.getId(),
      },
      stdio: "inherit",
    });
  } catch (error) {
    await stop();
    throw error;
  }

  project.provide(
    "sampleEndpoints",
    sampleEndpoints(
      pg.getHost(),
      {
        postgres: pg.getMappedPort(5432),
        mysql: my.getMappedPort(3306),
        mariadb: maria.getMappedPort(3306),
        sqlserver: mssql.getMappedPort(1433),
        // Plaintext TCP: samples allow plaintext when no lab CA is set.
        oracle: ora.getMappedPort(1521),
      },
      { adventureWorks: false },
    ),
  );
  return stop;
}
