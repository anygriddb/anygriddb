import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { ATTACHMENT_MAX_BYTES_CEILING } from "@anygriddb/core";
import { parseKeyRing, type KeyRing } from "./auth/key-ring.js";
import type { FileSettings } from "./files/index.js";

export type Env = {
  DATABASE_URL: string;
  /**
   * The key in use and the earlier ones still kept (ADR 0066):
   * AUTH_ENCRYPTION_KEY, then AUTH_ENCRYPTION_PREVIOUS_KEYS.
   */
  AUTH_ENCRYPTION_KEY: KeyRing;
  PORT: number;
  /**
   * The HTTPS origin people open: links in emails, cookies, API documents,
   * the certificate's primary name, and the WebAuthn RP ID. Passkeys need
   * a hostname here (or `localhost`); an IP alone keeps HTTPS and TOTP.
   * Always HTTPS, but for the development server on this machine (ADR 0029).
   */
  PUBLIC_URL: string;
  /** The operator's certificate and key (PEM); both, or neither. */
  TLS_CERT_FILE?: string;
  TLS_KEY_FILE?: string;
  /** Where the instance's own authority and certificate are kept. */
  TLS_DIR: string;
  /**
   * Extra names and addresses on the certificate only (SANs). Never the
   * WebAuthn RP ID (ADR 0029).
   */
  TLS_NAMES: string[];
  /** Where files live: a folder (the default) or an S3-compatible service. */
  STORAGE_DRIVER: "disk" | "s3";
  /** The folder of the disk driver. */
  STORAGE_PATH: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_BUCKET?: string;
  S3_SERVER_SIDE_ENCRYPTION?: "AES256" | "aws:kms";
  S3_KMS_KEY_ID?: string;
  ATTACHMENT_MAX_BYTES?: number;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;
  SAML_ENTRY_POINT?: string;
  SAML_ISSUER?: string;
  SAML_CERT?: string;
  SAML_CALLBACK_URL?: string;
  SAML_TRUST_ADDRESSES?: boolean;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  /** Accounts with these emails become instance administrators. */
  ADMIN_EMAILS?: string;
  /**
   * Connections of the pool every request reads and writes through, per
   * process. The workers and the realtime listener have their own.
   */
  DATABASE_POOL_MAX: number;
  /** Events, webhooks, automations, and schedules run at once, per process. */
  WORKER_CONCURRENCY: number;
  /** Uploads read at once, per process; one more is refused (503). */
  UPLOAD_CONCURRENCY: number;
  /** The most rows an export job writes to its file. */
  EXPORT_MAX_ROWS: number;
  /** The most rows one imported file may hold. */
  IMPORT_MAX_ROWS: number;
  /** Imports, exports, copies, and snapshots run at once, per process. */
  JOB_CONCURRENCY: number;
  /** Where sources may be declared (ADR 0006); empty allows none. */
  SOURCES_ALLOWED_HOSTS: string;
  /**
   * Reverse proxies whose `X-Forwarded-For` is the client address, as IP
   * addresses or CIDR ranges. Empty: the TCP peer is the client, and a
   * forwarded header is ignored.
   */
  TRUSTED_PROXIES: readonly string[];
  /** Development only: connect to sources without TLS (ADR 0026). */
  SOURCES_ALLOW_PLAINTEXT: boolean;
  /**
   * The bearer token `/metrics` asks for (ADR 0018); without one, there are
   * no metrics to read.
   */
  METRICS_TOKEN?: string;
  /** Where spans go (OTLP over HTTPS); without one, nothing is traced. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /**
   * Headers the OTLP exporter sends (for example Authorization). From
   * `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS_FILE`.
   */
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_SERVICE_NAME: string;
  /** Where sign-in events go as syslog over TLS; without one, nowhere. */
  SYSLOG?: SyslogCollector;
};

/** The syslog collector sign-in events are sent to over TLS (ADR 0084). */
export type SyslogCollector = {
  host: string;
  port: number;
  /** A certificate authority of the operator's, as PEM, beside the system's. */
  ca?: string;
};

/**
 * A whole number as it is written, in decimal digits and nothing else.
 * `Number` would also read "", " 5", "0x10", and "1e3". Shared by the
 * environment and the operator commands.
 */
export function strictInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A setting's whole number within its bounds; anything else stops the start. */
function boundedInteger(
  raw: string,
  name: string,
  least: number,
  most: number,
): number {
  const value = strictInteger(raw);
  if (value === undefined || value < least || value > most) {
    throw new Error(
      `${name} must be an integer between ${String(least)} and ${String(most)}`,
    );
  }
  return value;
}

/**
 * A file named by a setting, or the system's code for why it cannot be
 * read. Never the error itself: its message holds the path, and the start
 * prints an error with everything it carries.
 */
function settingFile(path: string): { text: string } | { failure: string } {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return { failure: typeof code === "string" ? code : "unknown error" };
  }
}

/** RFC 5425's own port. */
const SYSLOG_DEFAULT_PORT = 6514;
const SYSLOG_HOST = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;
const CERTIFICATE_PEM =
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;

/**
 * `SYSLOG_HOST`, `SYSLOG_PORT` and `SYSLOG_CA_FILE`: none without a host.
 * A value that names no collector stops the start, saying which.
 */
export function readSyslogCollector(
  source: NodeJS.ProcessEnv,
): SyslogCollector | undefined {
  const raw = source.SYSLOG_HOST?.trim();
  if (!raw) {
    if (source.SYSLOG_PORT || source.SYSLOG_CA_FILE) {
      throw new Error("SYSLOG_PORT and SYSLOG_CA_FILE need SYSLOG_HOST");
    }
    return undefined;
  }
  const host = raw.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!SYSLOG_HOST.test(host)) {
    throw new Error("SYSLOG_HOST must be a host name or an address");
  }
  const port = source.SYSLOG_PORT
    ? boundedInteger(source.SYSLOG_PORT, "SYSLOG_PORT", 1, 65_535)
    : SYSLOG_DEFAULT_PORT;
  if (!source.SYSLOG_CA_FILE) return { host, port };
  const file = settingFile(source.SYSLOG_CA_FILE);
  if ("failure" in file) {
    throw new Error(`SYSLOG_CA_FILE could not be read (${file.failure})`);
  }
  const ca = file.text;
  if (!CERTIFICATE_PEM.test(ca)) {
    throw new Error("SYSLOG_CA_FILE must hold a PEM certificate");
  }
  return { host, port, ca };
}

/**
 * A secret from `NAME`, or from the file `NAME_FILE` names, less its last
 * line break: what a container's secret store mounts. Both set is
 * refused at start, since one of them would be silently ignored.
 */
export function secretFromEnv(
  source: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const fileName = `${name}_FILE`;
  const direct = source[name];
  const filePath = source[fileName];
  const hasDirect = direct !== undefined && direct !== "";
  const hasFile = filePath !== undefined && filePath !== "";
  if (hasDirect && hasFile) {
    throw new Error(`${name} and ${fileName} cannot both be set`);
  }
  if (hasFile) {
    const file = settingFile(filePath);
    if ("failure" in file) {
      throw new Error(`${fileName} could not be read (${file.failure})`);
    }
    return file.text.replace(/\r?\n$/, "");
  }
  if (hasDirect) return direct;
  return undefined;
}

/** Like `secretFromEnv`, but required. */
function requiredSecret(source: NodeJS.ProcessEnv, name: string): string {
  const value = secretFromEnv(source, name);
  if (value === undefined || value === "") {
    throw new Error(`${name} or ${name}_FILE is required`);
  }
  return value;
}

/**
 * A ceiling on rows, 100,000 to 10,000,000: under that, a job would refuse
 * what the grid already exports; over it, a file outgrows what a
 * spreadsheet program opens and what a page read by page reaches in time.
 */
function rowCeiling(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  return boundedInteger(raw, name, 100_000, 10_000_000);
}

function count(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  least = 1,
): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  return boundedInteger(raw, name, least, 64);
}

/** A host on this machine only: the traffic never crosses a network. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * `PUBLIC_URL`. Only the origin is kept: the app is served at the root. It
 * is HTTPS (ADR 0029); plain HTTP names only the development server on this
 * machine, which forwards to the API's HTTPS. `WEB_ORIGIN`, its name before
 * the first release, is refused rather than ignored: an instance that still
 * sets it alone would start on localhost, with every link it mails wrong.
 */
export function publicUrl(source: NodeJS.ProcessEnv, port: number): string {
  if (!source.PUBLIC_URL && source.WEB_ORIGIN) {
    throw new Error(
      "WEB_ORIGIN is no longer read: set PUBLIC_URL to the same address",
    );
  }
  const raw = source.PUBLIC_URL || `https://localhost:${port}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_URL must be an https URL");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error(
      "PUBLIC_URL must be an https URL: AnyGridDB serves HTTPS only (plain HTTP is for the development server on this machine)",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be an origin, without a path");
  }
  return url.origin;
}

/**
 * A user or a password written with a `/`, a `?` or a `#` as it is typed
 * cuts the address short: the driver then reads another host, or says
 * "Invalid URL" and nothing else. Refused here instead, at start, with
 * what to change and not a word of the address itself. The stack's own
 * address is made of POSTGRES_USER and POSTGRES_PASSWORD as `.env` has
 * them, and a password generated in base64 holds a `/` every other time.
 */
function assertReadableDatabaseUrl(raw: string, name: string): void {
  const refuse = (): never => {
    throw new Error(
      `${name} cannot be read as an address: a "/", "?" or "#" in its user or password must be percent-encoded (%2F, %3F, %23). With the Compose stack, choose a POSTGRES_PASSWORD without them`,
    );
  };
  // No address has a fragment: a `#` is one that was meant as text.
  if (raw.includes("#")) refuse();
  const rest = raw.replace(/^[a-z]+:\/\//i, "");
  const end = rest.search(/[/?]/);
  const after = end === -1 ? "" : rest.slice(end);
  // `…:pass/word@host:5432/db`: the path would hold the host.
  const path = after.startsWith("/") ? (after.split("?")[0] ?? "") : "";
  const at = path.indexOf("@");
  if (at !== -1 && path.includes("/", at)) refuse();
  // `…:pass?word@host/db?sslmode=…`: the first setting's name would.
  const query = after.includes("?") ? after.slice(after.indexOf("?") + 1) : "";
  if ((query.split("=")[0] ?? "").includes("@")) refuse();
  // What is left, read as the driver reads it: an empty host, for a
  // socket named in `?host=`, is tried with a made-up one.
  if (
    !URL.canParse(raw, "postgres://base") &&
    !URL.canParse(raw.replace("@/", "@host/"), "postgres://base")
  ) {
    refuse();
  }
}

/**
 * What to add when PostgreSQL refuses the password of an address whose
 * user or password holds a `%XX`: the driver read it as the character it
 * encodes, so what was sent is not what was typed. Says that, and nothing
 * of the address.
 */
export function databasePasswordHint(
  raw: string,
  error: unknown,
): string | undefined {
  if ((error as { code?: unknown } | null)?.code !== "28P01") return undefined;
  const rest = raw.slice(raw.indexOf("://") + 3);
  const authority = rest.split(/[/?]/, 1)[0] ?? "";
  const account = authority.slice(0, authority.lastIndexOf("@") + 1);
  if (!/%[0-9a-f]{2}/i.test(account)) return undefined;
  return 'PostgreSQL refused the password. The user or password in DATABASE_URL holds a "%" and two hexadecimal digits, which are read as the one character they encode: to mean a "%" itself, write it %25. With the Compose stack, choose a POSTGRES_PASSWORD of letters and digits.';
}

/**
 * A PostgreSQL URL beyond this machine must verify TLS (ADR 0030):
 * `sslmode=verify-full`, or a mode node-postgres verifies the same way.
 * A Unix socket or the loopback stays on the machine.
 */
function assertEncryptedDatabase(raw: string, name: string): void {
  // `postgres://user@host:port/db?…`; the host may be empty, for a socket
  // named in `?host=`. Read by hand: an empty host is not a WHATWG URL.
  // The host follows the last `@`, as the driver reads it: an earlier one
  // is the password's, and what follows it must not be taken for a host.
  const match =
    /^(postgres(?:ql)?|socket):\/\/(?:[^/?]*@)?(\[[^\]]*\]|[^/:?]*)/i.exec(raw);
  if (!match) throw new Error(`${name} must be a postgres:// URL`);
  if (match[1]?.toLowerCase() === "socket") return;
  const params = new URLSearchParams(raw.split("?").slice(1).join("?"));
  const host = params.get("host") ?? decodeURIComponent(match[2] ?? "");
  if (host === "" || host.startsWith("/") || isLoopback(host)) return;
  const mode = params.get("sslmode");
  const ssl = params.get("ssl");
  // With libpq's semantics, `require` encrypts without checking who
  // answers, and `verify-ca` checks the authority and not the name: an
  // address the certificate does not hold was taken.
  const libpq = params.get("uselibpqcompat") === "true";
  const verified =
    mode === "verify-full" ||
    (!libpq &&
      (mode === "verify-ca" ||
        mode === "require" ||
        (mode === null && (ssl === "true" || ssl === "1"))));
  if (!verified) {
    throw new Error(
      `${name} reaches ${host} over the network: it must use verified TLS (add sslmode=verify-full, and sslrootcert for a private authority)`,
    );
  }
}

/** An https:// URL, or http:// on the loopback, for a service AnyGridDB calls. */
function assertEncryptedUrl(raw: string, name: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new Error(`${name} must be an https:// URL (ADR 0030)`);
}

/** Names and addresses, separated by commas or spaces. */
function names(source: NodeJS.ProcessEnv, name: string): string[] {
  const list = (source[name] ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of list) {
    if (!/^[a-z0-9.:-]+$/i.test(item) || item.length > 253) {
      throw new Error(`${name}: ${item} is not a host name or an address`);
    }
  }
  return list;
}

/** `true`, `1`, or `yes`; anything else, or nothing, is off. */
function flag(source: NodeJS.ProcessEnv, name: string): boolean {
  const value = source[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return false;
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

/** An IP address, or a range of them in CIDR notation. */
function isAddressOrRange(value: string): boolean {
  const [address = "", prefix, ...rest] = value.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return (
    /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
  );
}

/** Comma-separated addresses or ranges. Empty means no proxy is trusted. */
function trustedProxies(source: NodeJS.ProcessEnv): string[] {
  const list = (source.ANYGRIDDB_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!list.every(isAddressOrRange)) {
    throw new Error(
      "ANYGRIDDB_TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges",
    );
  }
  return list;
}

/**
 * Where files live. The operator commands read this alone, so moving files
 * needs no database or key.
 */
export function readFileSettings(
  source: NodeJS.ProcessEnv = process.env,
): FileSettings {
  const accessKey = secretFromEnv(source, "S3_ACCESS_KEY");
  const secretKey = secretFromEnv(source, "S3_SECRET_KEY");
  const s3Configured = Boolean(
    source.S3_ENDPOINT && accessKey && secretKey && source.S3_BUCKET,
  );
  // An instance that already keeps its files in S3 stays there unless
  // told otherwise; a new one keeps them on disk.
  const driver = source.STORAGE_DRIVER || (s3Configured ? "s3" : "disk");
  if (driver !== "disk" && driver !== "s3") {
    throw new Error("STORAGE_DRIVER must be disk or s3");
  }
  if (source.S3_ENDPOINT) assertEncryptedUrl(source.S3_ENDPOINT, "S3_ENDPOINT");
  const encryption = source.S3_SERVER_SIDE_ENCRYPTION || undefined;
  if (
    encryption !== undefined &&
    encryption !== "AES256" &&
    encryption !== "aws:kms"
  ) {
    throw new Error("S3_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
  }
  if (source.S3_KMS_KEY_ID && encryption !== "aws:kms") {
    throw new Error("S3_KMS_KEY_ID needs S3_SERVER_SIDE_ENCRYPTION=aws:kms");
  }
  return {
    STORAGE_DRIVER: driver,
    STORAGE_PATH: source.STORAGE_PATH || "./data/files",
    S3_ENDPOINT: source.S3_ENDPOINT || undefined,
    S3_REGION: source.S3_REGION || undefined,
    S3_ACCESS_KEY: accessKey,
    S3_SECRET_KEY: secretKey,
    S3_BUCKET: source.S3_BUCKET || undefined,
    S3_SERVER_SIDE_ENCRYPTION: encryption,
    S3_KMS_KEY_ID: source.S3_KMS_KEY_ID || undefined,
  };
}

/**
 * AUTH_ENCRYPTION_KEY: 32 bytes in base64, alone or as `id:base64`; and
 * AUTH_ENCRYPTION_PREVIOUS_KEYS, the earlier keys as `id:base64` separated
 * by commas, kept until `anygriddb keys rotate` has rewritten what they
 * sealed. Operator commands read them alone. Each accepts `_FILE`.
 */
export function readEncryptionKey(
  source: NodeJS.ProcessEnv = process.env,
): KeyRing {
  return parseKeyRing(
    requiredSecret(source, "AUTH_ENCRYPTION_KEY"),
    secretFromEnv(source, "AUTH_ENCRYPTION_PREVIOUS_KEYS"),
  );
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const key = readEncryptionKey(source);

  const port = boundedInteger(source.PORT ?? "4000", "PORT", 1, 65_535);
  const smtpPort = source.SMTP_PORT
    ? boundedInteger(source.SMTP_PORT, "SMTP_PORT", 1, 65_535)
    : undefined;

  const certFile = source.TLS_CERT_FILE || undefined;
  const keyFile = source.TLS_KEY_FILE || undefined;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE go together");
  }
  const allowPlaintext = flag(source, "ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT");
  if (allowPlaintext && source.NODE_ENV === "production") {
    throw new Error(
      "ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT is for development: a production instance reaches sources over verified TLS only",
    );
  }

  const databaseUrl = requiredSecret(source, "DATABASE_URL");
  assertReadableDatabaseUrl(databaseUrl, "DATABASE_URL");
  assertEncryptedDatabase(databaseUrl, "DATABASE_URL");
  if (source.SAML_ENTRY_POINT) {
    assertEncryptedUrl(source.SAML_ENTRY_POINT, "SAML_ENTRY_POINT");
  }
  if (source.OIDC_ISSUER) {
    assertEncryptedUrl(source.OIDC_ISSUER, "OIDC_ISSUER");
  }
  // Spans leave over verified TLS only, as every connection does (ADR 0030).
  if (source.OTEL_EXPORTER_OTLP_ENDPOINT) {
    assertEncryptedUrl(
      source.OTEL_EXPORTER_OTLP_ENDPOINT,
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    );
  }
  const metricsToken = secretFromEnv(source, "METRICS_TOKEN");
  if (metricsToken !== undefined && metricsToken.length < 32) {
    throw new Error("METRICS_TOKEN must be 32 characters or more");
  }
  const otelHeaders = secretFromEnv(source, "OTEL_EXPORTER_OTLP_HEADERS");
  const syslog = readSyslogCollector(source);

  return {
    DATABASE_URL: databaseUrl,
    AUTH_ENCRYPTION_KEY: key,
    PORT: port,
    PUBLIC_URL: publicUrl(source, port),
    ...(certFile && keyFile
      ? { TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile }
      : {}),
    TLS_DIR: source.TLS_DIR || "./data/tls",
    TLS_NAMES: names(source, "TLS_NAMES"),
    ...readFileSettings(source),
    ATTACHMENT_MAX_BYTES: source.ATTACHMENT_MAX_BYTES
      ? boundedInteger(
          source.ATTACHMENT_MAX_BYTES,
          "ATTACHMENT_MAX_BYTES",
          1024,
          ATTACHMENT_MAX_BYTES_CEILING,
        )
      : undefined,
    OIDC_ISSUER: source.OIDC_ISSUER,
    OIDC_CLIENT_ID: source.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: secretFromEnv(source, "OIDC_CLIENT_SECRET"),
    OIDC_REDIRECT_URL: source.OIDC_REDIRECT_URL,
    SAML_ENTRY_POINT: source.SAML_ENTRY_POINT,
    SAML_ISSUER: source.SAML_ISSUER,
    SAML_CERT: source.SAML_CERT,
    SAML_CALLBACK_URL: source.SAML_CALLBACK_URL,
    SAML_TRUST_ADDRESSES: flag(source, "SAML_TRUST_ADDRESSES"),
    SMTP_HOST: source.SMTP_HOST,
    SMTP_PORT: smtpPort,
    SMTP_USER: source.SMTP_USER,
    SMTP_PASSWORD: secretFromEnv(source, "SMTP_PASSWORD"),
    SMTP_FROM: source.SMTP_FROM,
    ADMIN_EMAILS: source.ADMIN_EMAILS,
    // A read holds one connection and asks for others meanwhile: fewer
    // than four and requests would wait on each other.
    DATABASE_POOL_MAX: count(source, "DATABASE_POOL_MAX", 10, 4),
    WORKER_CONCURRENCY: count(source, "WORKER_CONCURRENCY", 4),
    UPLOAD_CONCURRENCY: count(source, "UPLOAD_CONCURRENCY", 8),
    EXPORT_MAX_ROWS: rowCeiling(source, "EXPORT_MAX_ROWS", 1_000_000),
    IMPORT_MAX_ROWS: rowCeiling(source, "IMPORT_MAX_ROWS", 1_000_000),
    JOB_CONCURRENCY: count(source, "JOB_CONCURRENCY", 2),
    SOURCES_ALLOWED_HOSTS: source.ANYGRIDDB_SOURCES_ALLOWED_HOSTS ?? "",
    SOURCES_ALLOW_PLAINTEXT: allowPlaintext,
    TRUSTED_PROXIES: trustedProxies(source),
    ...(metricsToken ? { METRICS_TOKEN: metricsToken } : {}),
    ...(source.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { OTEL_EXPORTER_OTLP_ENDPOINT: source.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    ...(otelHeaders ? { OTEL_EXPORTER_OTLP_HEADERS: otelHeaders } : {}),
    OTEL_SERVICE_NAME: source.OTEL_SERVICE_NAME || "anygriddb",
    ...(syslog ? { SYSLOG: syslog } : {}),
  };
}
