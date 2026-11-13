/**
 * The certificate AnyGridDB serves (ADR 0029). The operator's own, when
 * they give one; otherwise one from the instance's own authority, made at
 * the first start and kept in `TLS_DIR`:
 *
 * - `authority.crt`: the authority people install once on workstations,
 *   limited to the instance's names (see certificate.ts);
 * - `server.crt`: the certificate served, renewed a month before it ends
 *   or when the names change;
 * - `*.key.enc`: their private keys, encrypted with AUTH_ENCRYPTION_KEY, so
 *   a copy of the volume alone gives neither away.
 */
import type { KeyRing } from "../auth/key-ring.js";
import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  chown,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { encryptSecret, openSecret } from "../auth/crypto.js";
import { issueAuthority, issueServer, type Issued } from "./certificate.js";

export type TlsSettings = {
  PUBLIC_URL: string;
  AUTH_ENCRYPTION_KEY: KeyRing;
  TLS_DIR: string;
  TLS_CERT_FILE?: string | undefined;
  TLS_KEY_FILE?: string | undefined;
  TLS_NAMES: readonly string[];
};

type CertificateInfo = {
  fingerprint: string;
  expires: string;
  names: string[];
};

/** What the server serves, and what administrators are shown of it. */
export type TlsState = {
  /** `operator`: the operator's certificate; `local`: the instance's authority. */
  mode: "operator" | "local";
  key: string;
  /** The certificate chain served. */
  cert: string;
  server: CertificateInfo;
  /** The authority to install, in local mode. */
  authority?: CertificateInfo & { cert: string };
  /** When the operator's files last changed, to reload them. */
  stamp?: string;
};

const RENEW_BEFORE_MS = 30 * 86_400_000;
const AUTHORITY_NAME = "AnyGridDB local authority";

function info(cert: X509Certificate): CertificateInfo {
  return {
    fingerprint: cert.fingerprint256,
    expires: new Date(cert.validTo).toISOString(),
    names: (cert.subjectAltName ?? "")
      .split(", ")
      .map((entry) => entry.replace(/^(DNS|IP Address):/, ""))
      .filter(Boolean),
  };
}

function covers(cert: X509Certificate, name: string): boolean {
  return isIP(name)
    ? cert.checkIP(name) !== undefined
    : cert.checkHost(name) !== undefined;
}

/** The names the server certificate covers: the public address, this machine, and the operator's extra ones. */
export function serverNames(settings: TlsSettings): string[] {
  const host = new URL(settings.PUBLIC_URL).hostname.replace(/^\[|\]$/g, "");
  return [
    ...new Set(
      [host, "localhost", "127.0.0.1", "::1", ...settings.TLS_NAMES].map(
        (name) => name.toLowerCase(),
      ),
    ),
  ];
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes beside, then renames: a crash never leaves half a file. */
async function writeAtomic(path: string, content: string, mode: number) {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

function sealed(key: string, secret: KeyRing): string {
  const { ciphertext, nonce } = encryptSecret(key, secret, "tls");
  return JSON.stringify({
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

/** The private key in a `*.key.enc` file, and the key that sealed it. */
function opened(
  text: string,
  secret: KeyRing,
): ReturnType<typeof openSecret> | undefined {
  try {
    const parsed = JSON.parse(text) as { nonce?: string; ciphertext?: string };
    if (!parsed.nonce || !parsed.ciphertext) return undefined;
    return openSecret(
      Buffer.from(parsed.ciphertext, "base64"),
      Buffer.from(parsed.nonce, "base64"),
      secret,
      "tls",
    );
  } catch {
    // Another key, or a damaged file.
    return undefined;
  }
}

/** The private key, or undefined: it is then issued anew. */
function unsealed(text: string, secret: KeyRing): string | undefined {
  return opened(text, secret)?.plaintext;
}

/**
 * Seals a private key file of the certificates folder again under the
 * current key, when an earlier one sealed it (ADR 0066). Answers which
 * key holds it now, or that no key of the ring opens it: left as it is,
 * the instance would issue a new authority at its next start.
 */
export async function resealTlsKey(
  dir: string,
  name: string,
  secret: KeyRing,
  write: boolean,
): Promise<{ keyId: string | null; rewritten: boolean } | "unreadable"> {
  const path = join(dir, name);
  const text = await readText(path);
  const key = text ? opened(text, secret) : undefined;
  if (!key) return "unreadable";
  if (key.keyId === secret.currentId || !write) {
    return { keyId: key.keyId, rewritten: false };
  }
  await writeAtomic(path, sealed(key.plaintext, secret), 0o600);
  return { keyId: secret.currentId, rewritten: true };
}

type Log = (message: string) => void;

/**
 * The two authorities an instance keeps. `authority` signs the certificate
 * browsers see, and is what people install. `internal-authority` signs
 * the certificates of the stack's own services (PostgreSQL, RustFS);
 * only AnyGridDB trusts it, and only for those services' names.
 */
type Kind = "authority" | "internal-authority";

const COMMON_NAMES: Record<Kind, string> = {
  authority: AUTHORITY_NAME,
  "internal-authority": "AnyGridDB internal authority",
};

async function localAuthority(
  settings: TlsSettings,
  names: readonly string[],
  log: Log,
  kind: Kind = "authority",
): Promise<{
  issued: Issued;
  cert: X509Certificate;
  fresh: boolean;
  /** The names it may vouch for: its name constraints. */
  permitted: string[];
}> {
  const dir = settings.TLS_DIR;
  const certText = await readText(join(dir, `${kind}.crt`));
  const keyText = await readText(join(dir, `${kind}.key.enc`));
  const key = keyText
    ? unsealed(keyText, settings.AUTH_ENCRYPTION_KEY)
    : undefined;
  if (certText && key) {
    const cert = new X509Certificate(certText);
    const permitted = JSON.parse(
      (await readText(join(dir, `${kind}.json`))) ?? "{}",
    ) as { names?: string[] };
    const allowed = new Set(permitted.names ?? []);
    const valid =
      new Date(cert.validTo).getTime() - Date.now() > 365 * 86_400_000;
    if (valid && names.every((name) => allowed.has(name))) {
      return {
        issued: { cert: certText, key },
        cert,
        fresh: false,
        permitted: [...allowed],
      };
    }
    log(
      kind === "authority"
        ? "the local authority does not cover the instance's names any more, or ends within a year: issuing a new one, which workstations must install again"
        : "the internal authority does not cover the stack's services any more, or ends within a year: issuing a new one",
    );
  }
  const issued = issueAuthority({ commonName: COMMON_NAMES[kind], names });
  await writeAtomic(
    join(dir, `${kind}.key.enc`),
    sealed(issued.key, settings.AUTH_ENCRYPTION_KEY),
    0o600,
  );
  await writeAtomic(join(dir, `${kind}.crt`), issued.cert, 0o644);
  await writeAtomic(
    join(dir, `${kind}.json`),
    `${JSON.stringify({ names }, null, 2)}\n`,
    0o644,
  );
  return {
    issued,
    cert: new X509Certificate(issued.cert),
    fresh: true,
    permitted: [...names],
  };
}

async function localTls(settings: TlsSettings, log: Log): Promise<TlsState> {
  await mkdir(settings.TLS_DIR, { recursive: true, mode: 0o700 });
  const names = serverNames(settings);
  const authority = await localAuthority(settings, names, log);
  const dir = settings.TLS_DIR;
  const certText = await readText(join(dir, "server.crt"));
  const keyText = await readText(join(dir, "server.key.enc"));
  const key = keyText
    ? unsealed(keyText, settings.AUTH_ENCRYPTION_KEY)
    : undefined;
  let server: Issued | undefined;
  if (!authority.fresh && certText && key) {
    const cert = new X509Certificate(certText);
    const current =
      cert.checkIssued(authority.cert) &&
      cert.verify(authority.cert.publicKey) &&
      new Date(cert.validTo).getTime() - Date.now() > RENEW_BEFORE_MS &&
      names.every((name) => covers(cert, name));
    if (current) server = { cert: certText, key };
  }
  if (!server) {
    server = issueServer({
      names,
      authority: {
        cert: authority.issued.cert,
        key: createPrivateKey(authority.issued.key),
        publicKey: authority.cert.publicKey,
        commonName: AUTHORITY_NAME,
      },
    });
    await writeAtomic(
      join(dir, "server.key.enc"),
      sealed(server.key, settings.AUTH_ENCRYPTION_KEY),
      0o600,
    );
    await writeAtomic(join(dir, "server.crt"), server.cert, 0o644);
  }
  return {
    mode: "local",
    key: server.key,
    cert: server.cert + authority.issued.cert,
    server: info(new X509Certificate(server.cert)),
    authority: {
      ...info(authority.cert),
      names: authority.permitted,
      cert: authority.issued.cert,
    },
  };
}

async function operatorTls(
  settings: TlsSettings,
  certFile: string,
  keyFile: string,
  log: Log,
): Promise<TlsState> {
  const [cert, key, certStat, keyStat] = await Promise.all([
    readFile(certFile, "utf8"),
    readFile(keyFile, "utf8"),
    stat(certFile),
    stat(keyFile),
  ]);
  // A file that is not a certificate or a key stops the start here.
  const leaf = new X509Certificate(cert);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) {
    throw new Error("TLS_KEY_FILE is not the key of TLS_CERT_FILE");
  }
  const host = serverNames(settings)[0] ?? "localhost";
  if (!covers(leaf, host)) {
    log(`TLS_CERT_FILE does not name ${host}, the host of PUBLIC_URL`);
  }
  if (new Date(leaf.validTo).getTime() - Date.now() < 14 * 86_400_000) {
    log(`TLS_CERT_FILE ends on ${leaf.validTo}: renew it`);
  }
  return {
    mode: "operator",
    key,
    cert,
    server: info(leaf),
    stamp: `${String(certStat.mtimeMs)}:${String(keyStat.mtimeMs)}`,
  };
}

/** The certificate to serve now, made or renewed as needed. */
export async function loadTls(
  settings: TlsSettings,
  log: Log,
): Promise<TlsState> {
  if (settings.TLS_CERT_FILE && settings.TLS_KEY_FILE) {
    return operatorTls(
      settings,
      settings.TLS_CERT_FILE,
      settings.TLS_KEY_FILE,
      log,
    );
  }
  return localTls(settings, log);
}

/**
 * The certificate to serve after `current`: the same object when nothing
 * changed, else a renewed local one or the operator's new files.
 */
export async function refreshTls(
  settings: TlsSettings,
  current: TlsState,
  log: Log,
): Promise<TlsState> {
  if (current.mode === "operator") {
    const [certStat, keyStat] = await Promise.all([
      stat(settings.TLS_CERT_FILE ?? ""),
      stat(settings.TLS_KEY_FILE ?? ""),
    ]);
    const stamp = `${String(certStat.mtimeMs)}:${String(keyStat.mtimeMs)}`;
    return stamp === current.stamp ? current : loadTls(settings, log);
  }
  const ends = new Date(current.server.expires).getTime();
  return ends - Date.now() > RENEW_BEFORE_MS ? current : loadTls(settings, log);
}

/** A service of the stack that AnyGridDB reaches over TLS (ADR 0030). */
export type StackService = {
  /** Its name on the stack's network, which its certificate names. */
  name: string;
  /** The user and group it runs as: its key is theirs alone. */
  owner?: { uid: number; gid: number };
  /** PostgreSQL: also a pg_hba.conf that takes TLS connections only. */
  postgres?: boolean;
};

/** Over the stack's network, PostgreSQL takes encrypted connections only. */
const PG_HBA = `# Written by AnyGridDB (ADR 0030): over the network, TLS only.
local   all  all                trust
hostssl all  all  0.0.0.0/0     scram-sha-256
hostssl all  all  ::/0          scram-sha-256
`;

/**
 * Certificates for the stack's services, from the internal authority:
 * `<out>/<name>/<name>_cert.pem` and `<name>_key.pem` (the latter readable
 * by the service's user alone), and `<out>/internal-authority.crt`, which
 * AnyGridDB trusts for them. Issued anew at each run, for five years.
 */
export async function issueServiceCertificates(
  settings: Pick<TlsSettings, "AUTH_ENCRYPTION_KEY" | "TLS_DIR">,
  services: readonly StackService[],
  out: string,
  log: Log,
): Promise<{ fingerprint: string }> {
  if (services.length === 0) throw new Error("No service to issue for");
  for (const service of services) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(service.name)) {
      throw new Error(`${service.name} is not a host name`);
    }
  }
  await mkdir(settings.TLS_DIR, { recursive: true, mode: 0o700 });
  const names = services.map((service) => service.name);
  const authority = await localAuthority(
    { ...settings, PUBLIC_URL: "https://localhost", TLS_NAMES: [] },
    names,
    log,
    "internal-authority",
  );
  const signer = {
    cert: authority.issued.cert,
    key: createPrivateKey(authority.issued.key),
    publicKey: authority.cert.publicKey,
    commonName: COMMON_NAMES["internal-authority"],
  };
  await mkdir(out, { recursive: true, mode: 0o755 });
  for (const service of services) {
    const dir = join(out, service.name);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const issued = issueServer({
      names: [service.name],
      authority: signer,
      days: 5 * 365,
    });
    const files: Array<[string, string, number]> = [
      [`${service.name}_cert.pem`, issued.cert, 0o644],
      [`${service.name}_key.pem`, issued.key, 0o600],
      ...(service.postgres
        ? [["pg_hba.conf", PG_HBA, 0o600] as [string, string, number]]
        : []),
    ];
    for (const [file, content, mode] of files) {
      const path = join(dir, file);
      await writeAtomic(path, content, mode);
      if (service.owner) {
        await chown(path, service.owner.uid, service.owner.gid);
      }
    }
    if (service.owner) await chown(dir, service.owner.uid, service.owner.gid);
  }
  await writeAtomic(
    join(out, "internal-authority.crt"),
    authority.issued.cert,
    0o644,
  );
  return { fingerprint: authority.cert.fingerprint256 };
}
