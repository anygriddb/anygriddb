/**
 * Operator commands, run where the API runs (`anygriddb` in the image):
 *
 *   anygriddb storage migrate --from disk --to s3 [--dry-run]
 *   anygriddb storage sweep [--dry-run]
 *   anygriddb health
 *   anygriddb version
 *   anygriddb tls services --out <dir> [--postgres <name[:uid:gid]>] [--service <name[:uid:gid]>]…
 *   anygriddb keys new [--id <id>]
 *   anygriddb keys status
 *   anygriddb keys rotate
 *
 * They read the API's environment. `migrate` needs only the storage
 * settings; `sweep` also needs DATABASE_URL; `keys status` and `keys
 * rotate` need DATABASE_URL and the encryption keys.
 */
import { parseArgs } from "node:util";
import { createDb } from "@anygriddb/db";
import { rotateKeys, type KeyRotation } from "./auth/key-rotation.js";
import { mintKey } from "./auth/key-ring.js";
import { BUILD, describeBuild } from "./build-info.js";
import { readEncryptionKey, readFileSettings } from "./env.js";
import { healthAuthorities, probeHealth, publicHost } from "./health-probe.js";
import {
  issueServiceCertificates,
  type StackService,
} from "./tls/authority.js";
import { createFileStore, type FileSettings } from "./files/index.js";
import { sweepOrphanFiles } from "./files/sweep.js";
import { copyFiles, type CopyReport } from "./files/transfer.js";

const USAGE = `Usage:
  anygriddb storage migrate --from <disk|s3> --to <disk|s3> [--dry-run] [--concurrency <n>]
      Copies every file the target lacks. Nothing is deleted.
  anygriddb storage sweep [--dry-run]
      Deletes files older than a day that no row names.
  anygriddb health
      Exits 0 when the API on this machine answers (container health checks).
  anygriddb version [--json]
      The version, commit, and build time of this AnyGridDB.
  anygriddb tls services --out <dir> [--postgres <name[:uid:gid]>] [--service <name[:uid:gid]>]
      Issues the stack's services their certificates, from the instance's
      internal authority: <dir>/<name>/<name>_cert.pem and _key.pem, owned
      by uid:gid, and <dir>/internal-authority.crt.
  anygriddb keys new [--id <id>]
      Prints a new encryption key, named by today's date or by <id>, as
      AUTH_ENCRYPTION_KEY takes it. Nothing is changed.
  anygriddb keys status
      Counts what the instance keeps sealed, by the key that sealed it.
  anygriddb keys rotate
      Seals again, under AUTH_ENCRYPTION_KEY, what an earlier key sealed.
      That earlier key must be in AUTH_ENCRYPTION_PREVIOUS_KEYS.
`;

class UsageError extends Error {}

/** `parseArgs` reports an unknown or malformed flag this way. */
function parseError(error: unknown): error is Error {
  return (
    error instanceof TypeError &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  );
}

function driverOf(value: string | undefined, flag: string) {
  if (value !== "disk" && value !== "s3") {
    throw new UsageError(`${flag} must be disk or s3`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function migrate(args: string[], settings: FileSettings) {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      concurrency: { type: "string", default: "4" },
    },
    strict: true,
  });
  const from = driverOf(values.from, "--from");
  const to = driverOf(values.to, "--to");
  if (from === to) throw new UsageError("--from and --to must differ");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new UsageError("--concurrency must be an integer between 1 and 32");
  }
  const source = createFileStore({ ...settings, STORAGE_DRIVER: from });
  const target = createFileStore({ ...settings, STORAGE_DRIVER: to });
  // Creates the folder or the bucket, and proves the target is writable.
  if (!values["dry-run"]) await target.check();

  let shown = Date.now();
  const progress = (report: CopyReport) => {
    if (Date.now() - shown < 2_000) return;
    shown = Date.now();
    process.stderr.write(
      `… ${report.copied} copied, ${report.skipped} already there, ${report.failed} failed\n`,
    );
  };
  const report = await copyFiles(source, target, {
    dryRun: values["dry-run"],
    concurrency,
    onError: (key, error) => {
      process.stderr.write(`failed ${key}: ${message(error)}\n`);
    },
    onProgress: progress,
  });
  const verb = values["dry-run"] ? "would copy" : "copied";
  process.stdout.write(
    `${verb} ${report.copied} files (${size(report.bytes)}), ${report.skipped} already in ${to}, ${report.failed} failed\n`,
  );
  if (!values["dry-run"] && report.failed === 0 && report.copied > 0) {
    process.stdout.write(
      `Next: set STORAGE_DRIVER=${to}, restart the API, then run this command again to copy what was written meanwhile.\n`,
    );
  }
  return report.failed === 0 ? 0 : 1;
}

async function sweep(args: string[], settings: FileSettings) {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false } },
    strict: true,
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError("DATABASE_URL is required");
  const files = createFileStore(settings);
  const { db, close } = createDb(url, { max: 2 });
  let failed = 0;
  try {
    const report = await sweepOrphanFiles(
      { db, files },
      {
        dryRun: values["dry-run"],
        onOrphan: values["dry-run"]
          ? (key) => process.stdout.write(`${key}\n`)
          : undefined,
        onError: (key, error) => {
          failed += 1;
          process.stderr.write(`failed ${key}: ${message(error)}\n`);
        },
      },
    );
    const verb = values["dry-run"] ? "would remove" : "removed";
    process.stdout.write(
      `checked ${report.checked} files in ${files.driver}, ${verb} ${report.removed}, cleared ${report.tidied} leftovers\n`,
    );
  } finally {
    await close();
  }
  return failed === 0 ? 0 : 1;
}

/** Whether the API on this machine answers over verified HTTPS. */
async function health(): Promise<number> {
  const port = Number(process.env.PORT ?? "4000");
  return probeHealth({
    port,
    host: publicHost(process.env, port),
    ca: await healthAuthorities(process.env),
  });
}

/** Which AnyGridDB this is: one line, or the facts as JSON. */
function version(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    strict: true,
  });
  process.stdout.write(
    values.json ? `${JSON.stringify(BUILD)}\n` : `${describeBuild(BUILD)}\n`,
  );
  return 0;
}

/** `db:999:999`: a service's name, and the user and group its key belongs to. */
function service(spec: string, postgres: boolean): StackService {
  const [name = "", uid, gid] = spec.split(":");
  if (uid === undefined) return { name, postgres };
  const owner = { uid: Number(uid), gid: Number(gid ?? uid) };
  if (!Number.isInteger(owner.uid) || !Number.isInteger(owner.gid)) {
    throw new UsageError(`${spec}: expected name:uid:gid`);
  }
  return { name, owner, postgres };
}

async function tlsServices(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      postgres: { type: "string", multiple: true, default: [] },
      service: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  if (!values.out) throw new UsageError("--out is required");
  const services = [
    ...values.postgres.map((spec) => service(spec, true)),
    ...values.service.map((spec) => service(spec, false)),
  ];
  if (services.length === 0) {
    throw new UsageError("name at least one --postgres or --service");
  }
  const { fingerprint } = await issueServiceCertificates(
    {
      AUTH_ENCRYPTION_KEY: readEncryptionKey(),
      TLS_DIR: process.env.TLS_DIR || "./data/tls",
    },
    services,
    values.out,
    (note) => process.stderr.write(`${note}\n`),
  );
  process.stdout.write(
    `issued ${services.map((item) => item.name).join(", ")}; internal authority ${fingerprint}\n`,
  );
  return 0;
}

function keysNew(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { id: { type: "string" } },
    strict: true,
  });
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  try {
    process.stdout.write(`${mintKey(values.id ?? today)}\n`);
  } catch (error) {
    throw new UsageError(message(error));
  }
  return 0;
}

function describeKeys(report: KeyRotation, current: string): string {
  const lines = Object.entries(report.byKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, count]) =>
        `${String(count).padStart(8)}  ${id}${id === current ? " (current)" : ""}`,
    );
  return [
    lines.length > 0 ? lines.join("\n") : "nothing sealed yet",
    ...report.unreadable.map((where) => `no key opens: ${where}`),
  ].join("\n");
}

/** Counts sealed values by key and, for `rotate`, seals the old ones again. */
async function keys(write: boolean): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError("DATABASE_URL is required");
  const ring = readEncryptionKey();
  const { db, close } = createDb(url, { max: 2 });
  try {
    const report = await rotateKeys(db, ring, {
      write,
      tlsDir: process.env.TLS_DIR || "./data/tls",
    });
    process.stdout.write(`${describeKeys(report, ring.currentId)}\n`);
    if (write) {
      process.stdout.write(
        `sealed ${String(report.rewritten)} again under ${ring.currentId}\n`,
      );
    }
    const earlier = Object.keys(report.byKey).filter(
      (id) => id !== ring.currentId,
    );
    if (report.unreadable.length > 0) {
      process.stderr.write(
        "Some values open with no key given: add the key that sealed them to AUTH_ENCRYPTION_PREVIOUS_KEYS and run this again.\n",
      );
      return 1;
    }
    if (earlier.length === 0 && ring.masters.size > 1) {
      process.stdout.write(
        "Nothing is left under an earlier key. Backup codes made before the change stop working once AUTH_ENCRYPTION_PREVIOUS_KEYS is emptied.\n",
      );
    }
    return 0;
  } finally {
    await close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (group === "storage" && command === "migrate") {
      return await migrate(rest, readFileSettings());
    }
    if (group === "storage" && command === "sweep") {
      return await sweep(rest, readFileSettings());
    }
    if (group === "health" && command === undefined) {
      return await health();
    }
    if (group === "version" || group === "--version") {
      return version(command === undefined ? rest : [command, ...rest]);
    }
    if (group === "tls" && command === "services") {
      return await tlsServices(rest);
    }
    if (group === "keys" && command === "new") {
      return keysNew(rest);
    }
    if (group === "keys" && (command === "status" || command === "rotate")) {
      parseArgs({ args: rest, options: {}, strict: true });
      return await keys(command === "rotate");
    }
    if (group === undefined || group === "help" || group === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    throw new UsageError(`Unknown command: ${argv.join(" ")}`);
  } catch (error) {
    if (error instanceof UsageError || parseError(error)) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`${message(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
