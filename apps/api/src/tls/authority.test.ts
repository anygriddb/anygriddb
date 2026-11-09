import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueServiceCertificates,
  loadTls,
  refreshTls,
  serverNames,
  type TlsSettings,
} from "./authority.js";
import { issueAuthority } from "./certificate.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function settings(
  patch: Partial<TlsSettings> = {},
): Promise<TlsSettings> {
  const dir = await mkdtemp(join(tmpdir(), "anygriddb-tls-"));
  dirs.push(dir);
  return {
    PUBLIC_URL: "https://grid.lan:3000",
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    TLS_DIR: join(dir, "tls"),
    TLS_NAMES: [],
    ...patch,
  };
}

const quiet = () => undefined;

describe("the certificate AnyGridDB serves", () => {
  it("names the public host, this machine, and the operator's extra names", async () => {
    expect(
      serverNames(
        await settings({
          PUBLIC_URL: "https://[::1]:3000",
          TLS_NAMES: ["Grid.Corp", "10.0.0.5"],
        }),
      ),
    ).toEqual(["::1", "localhost", "127.0.0.1", "grid.corp", "10.0.0.5"]);
  });

  it("makes an authority once, keeps it, and keeps its keys sealed", async () => {
    const options = await settings();
    const first = await loadTls(options, quiet);
    expect(first.mode).toBe("local");
    expect(first.server.names).toEqual(
      expect.arrayContaining(["grid.lan", "localhost", "127.0.0.1"]),
    );
    const leaf = new X509Certificate(first.cert);
    expect(leaf.checkHost("grid.lan")).toBe("grid.lan");
    // Private keys never lie on disk in clear.
    const sealed = await readFile(
      join(options.TLS_DIR, "authority.key.enc"),
      "utf8",
    );
    expect(sealed).not.toContain("PRIVATE KEY");
    expect(
      (await stat(join(options.TLS_DIR, "server.key.enc"))).mode & 0o777,
    ).toBe(0o600);

    expect(first.authority?.names).toEqual([
      "grid.lan",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
    const again = await loadTls(options, quiet);
    expect(again.authority?.fingerprint).toBe(first.authority?.fingerprint);
    expect(again.server.fingerprint).toBe(first.server.fingerprint);
    expect(await refreshTls(options, again, quiet)).toBe(again);

    // A new name the authority was not made for: a new authority.
    const notes: string[] = [];
    const grown = await loadTls(
      { ...options, TLS_NAMES: ["grid.corp"] },
      (note) => notes.push(note),
    );
    expect(grown.authority?.fingerprint).not.toBe(first.authority?.fingerprint);
    expect(notes.join(" ")).toContain("install again");

    // Another encryption key cannot open the keys: issued anew.
    const rekeyed = await loadTls(
      {
        ...options,
        TLS_NAMES: ["grid.corp"],
        AUTH_ENCRYPTION_KEY: randomBytes(32),
      },
      quiet,
    );
    expect(rekeyed.authority?.fingerprint).not.toBe(
      grown.authority?.fingerprint,
    );
  });

  it("serves the operator's certificate when given one, and checks its key", async () => {
    const options = await settings();
    const own = issueAuthority({ commonName: "grid.lan", names: ["grid.lan"] });
    const other = issueAuthority({ commonName: "other", names: ["other"] });
    const certFile = join(options.TLS_DIR, "..", "own.crt");
    const keyFile = join(options.TLS_DIR, "..", "own.key");
    await writeFile(certFile, own.cert);
    await writeFile(keyFile, own.key);
    const state = await loadTls(
      { ...options, TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile },
      quiet,
    );
    expect(state.mode).toBe("operator");
    expect(state.authority).toBeUndefined();
    await writeFile(keyFile, other.key);
    await expect(
      loadTls(
        { ...options, TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile },
        quiet,
      ),
    ).rejects.toThrow(/not the key/);
  });

  it("issues the stack's services their certificates from an internal authority", async () => {
    const options = await settings();
    const out = join(options.TLS_DIR, "..", "certs");
    const first = await issueServiceCertificates(
      options,
      [{ name: "db", postgres: true }, { name: "rustfs" }],
      out,
      quiet,
    );
    const authority = new X509Certificate(
      await readFile(join(out, "internal-authority.crt"), "utf8"),
    );
    expect(authority.fingerprint256).toBe(first.fingerprint);
    const db = new X509Certificate(
      await readFile(join(out, "db", "db_cert.pem"), "utf8"),
    );
    expect(db.checkHost("db")).toBe("db");
    expect(db.checkIssued(authority)).toBe(true);
    expect((await stat(join(out, "db", "db_key.pem"))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(join(out, "db", "pg_hba.conf"), "utf8")).toContain(
      "hostssl",
    );
    await expect(stat(join(out, "rustfs", "pg_hba.conf"))).rejects.toThrow();
    // Apart from the authority people install, and kept across runs.
    const again = await issueServiceCertificates(
      options,
      [{ name: "db", postgres: true }, { name: "rustfs" }],
      out,
      quiet,
    );
    expect(again.fingerprint).toBe(first.fingerprint);
    const browser = await loadTls(options, quiet);
    expect(browser.authority?.fingerprint).not.toBe(first.fingerprint);
  });
});
