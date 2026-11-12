import { isIP } from "node:net";
import { ATTACHMENT_MAX_BYTES_CEILING } from "@anygriddb/core";
import type { FileSettings } from "./files/index.js";

export type Env = {
  DATABASE_URL: string;
  AUTH_ENCRYPTION_KEY: Buffer;
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
  OTEL_SERVICE_NAME: string;
};

function count(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  least = 1,
): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < least || value > 64) {
    throw new Error(
      `${name} must be an integer between ${String(least)} and 64`,
    );
  }
  return value;
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
 * `PUBLIC_URL`, or `WEB_ORIGIN` from before the app and the API shared an
 * origin. Only the origin is kept: the app is served at the root. It is
 * HTTPS (ADR 0029); plain HTTP names only the development server on this
 * machine, which forwards to the API's HTTPS.
 */
function publicUrl(source: NodeJS.ProcessEnv, port: number): string {
  const raw =
    source.PUBLIC_URL || source.WEB_ORIGIN || `https://localhost:${port}`;
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
 * A PostgreSQL URL beyond this machine must verify TLS (ADR 0030):
 * `sslmode=verify-full`, or a mode node-postgres verifies the same way.
 * A Unix socket or the loopback stays on the machine.
 */
export function assertEncryptedDatabase(raw: string, name: string): void {
  // `postgres://user@host:port/db?…`; the host may be empty, for a socket
  // named in `?host=`. Read by hand: an empty host is not a WHATWG URL.
  const match =
    /^(postgres(?:ql)?|socket):\/\/(?:[^@/?]*@)?(\[[^\]]*\]|[^/:?]*)/i.exec(
      raw,
    );
  if (!match) throw new Error(`${name} must be a postgres:// URL`);
  if (match[1]?.toLowerCase() === "socket") return;
  const params = new URLSearchParams(raw.split("?").slice(1).join("?"));
  const host = params.get("host") ?? decodeURIComponent(match[2] ?? "");
  if (host === "" || host.startsWith("/") || isLoopback(host)) return;
  const mode = params.get("sslmode");
  const ssl = params.get("ssl");
  // With libpq's semantics, `require` encrypts without checking who answers.
  const libpq = params.get("uselibpqcompat") === "true";
  const verified =
    mode === "verify-full" ||
    mode === "verify-ca" ||
    (!libpq &&
      (mode === "require" ||
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

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Where files live. The operator commands read this alone, so moving files
 * needs no database or key.
 */
export function readFileSettings(
  source: NodeJS.ProcessEnv = process.env,
): FileSettings {
  const s3Configured = Boolean(
    source.S3_ENDPOINT &&
    source.S3_ACCESS_KEY &&
    source.S3_SECRET_KEY &&
    source.S3_BUCKET,
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
    S3_ENDPOINT: source.S3_ENDPOINT,
    S3_REGION: source.S3_REGION,
    S3_ACCESS_KEY: source.S3_ACCESS_KEY,
    S3_SECRET_KEY: source.S3_SECRET_KEY,
    S3_BUCKET: source.S3_BUCKET,
    S3_SERVER_SIDE_ENCRYPTION: encryption,
    S3_KMS_KEY_ID: source.S3_KMS_KEY_ID || undefined,
  };
}

/** AUTH_ENCRYPTION_KEY: 32 bytes, base64. Operator commands read it alone. */
export function readEncryptionKey(
  source: NodeJS.ProcessEnv = process.env,
): Buffer {
  const key = Buffer.from(required(source, "AUTH_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const key = readEncryptionKey(source);

  const port = Number(source.PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const smtpPort = source.SMTP_PORT ? Number(source.SMTP_PORT) : undefined;
  if (
    smtpPort !== undefined &&
    (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
  ) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

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

  const databaseUrl = required(source, "DATABASE_URL");
  assertEncryptedDatabase(databaseUrl, "DATABASE_URL");
  if (source.SAML_ENTRY_POINT) {
    assertEncryptedUrl(source.SAML_ENTRY_POINT, "SAML_ENTRY_POINT");
  }
  // Spans leave over verified TLS only, as every connection does (ADR 0030).
  if (source.OTEL_EXPORTER_OTLP_ENDPOINT) {
    assertEncryptedUrl(
      source.OTEL_EXPORTER_OTLP_ENDPOINT,
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    );
  }
  const metricsToken = source.METRICS_TOKEN || undefined;
  if (metricsToken !== undefined && metricsToken.length < 32) {
    throw new Error("METRICS_TOKEN must be 32 characters or more");
  }

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
      ? Math.max(
          1024,
          Math.min(
            ATTACHMENT_MAX_BYTES_CEILING,
            Number(source.ATTACHMENT_MAX_BYTES) || 0,
          ),
        )
      : undefined,
    OIDC_ISSUER: source.OIDC_ISSUER,
    OIDC_CLIENT_ID: source.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: source.OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URL: source.OIDC_REDIRECT_URL,
    SAML_ENTRY_POINT: source.SAML_ENTRY_POINT,
    SAML_ISSUER: source.SAML_ISSUER,
    SAML_CERT: source.SAML_CERT,
    SAML_CALLBACK_URL: source.SAML_CALLBACK_URL,
    SMTP_HOST: source.SMTP_HOST,
    SMTP_PORT: smtpPort,
    SMTP_USER: source.SMTP_USER,
    SMTP_PASSWORD: source.SMTP_PASSWORD,
    SMTP_FROM: source.SMTP_FROM,
    ADMIN_EMAILS: source.ADMIN_EMAILS,
    // A read holds one connection and asks for others meanwhile: fewer
    // than four and requests would wait on each other.
    DATABASE_POOL_MAX: count(source, "DATABASE_POOL_MAX", 10, 4),
    WORKER_CONCURRENCY: count(source, "WORKER_CONCURRENCY", 4),
    UPLOAD_CONCURRENCY: count(source, "UPLOAD_CONCURRENCY", 8),
    JOB_CONCURRENCY: count(source, "JOB_CONCURRENCY", 2),
    SOURCES_ALLOWED_HOSTS: source.ANYGRIDDB_SOURCES_ALLOWED_HOSTS ?? "",
    SOURCES_ALLOW_PLAINTEXT: allowPlaintext,
    TRUSTED_PROXIES: trustedProxies(source),
    ...(metricsToken ? { METRICS_TOKEN: metricsToken } : {}),
    ...(source.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { OTEL_EXPORTER_OTLP_ENDPOINT: source.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    OTEL_SERVICE_NAME: source.OTEL_SERVICE_NAME || "anygriddb",
  };
}
