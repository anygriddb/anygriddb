import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyRing } from "../auth/key-ring.js";
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
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    TLS_DIR: join(dir, "tls"),
    TLS_NAMES: [],
    ...patch,
  };
}

const quiet = () => undefined;

/**
 * Whether a client that trusts `authority` alone takes the certificate a
 * service named `name` serves: a real handshake, checked as PostgreSQL's
 * and the files' store's clients check theirs.
 */
async function handshake(
  served: { cert: string; key: string },
  authority: string,
  name: string,
): Promise<string> {
  const server = createServer({ cert: served.cert, key: served.key });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<string>((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername: name,
        ca: authority,
      });
      socket.once("secureConnect", () => {
        socket.end();
        resolve("verified");
      });
      socket.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? "refused"),
      );
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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
        AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
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

  it("keeps a running service verified when another joins the stack", async () => {
    const options = await settings();
    const out = join(options.TLS_DIR, "..", "certs");
    const read = (...path: string[]) => readFile(join(out, ...path), "utf8");
    await issueServiceCertificates(
      options,
      [{ name: "db", postgres: true }],
      out,
      quiet,
    );
    // PostgreSQL is running: it keeps serving what it read at its start.
    const running = {
      cert: await read("db", "db_cert.pem"),
      key: await read("db", "db_key.pem"),
    };
    const before = await read("internal-authority.crt");

    await issueServiceCertificates(
      options,
      [{ name: "db", postgres: true }, { name: "rustfs" }],
      out,
      quiet,
    );
    const after = await read("internal-authority.crt");
    // The authority now vouches for the new service too...
    const store = {
      cert: await read("rustfs", "rustfs_cert.pem"),
      key: await read("rustfs", "rustfs_key.pem"),
    };
    expect(await handshake(store, after, "rustfs")).toBe("verified");
    expect(await handshake(store, before, "rustfs")).not.toBe("verified");
    // ...and whoever reads it now still takes the service that never
    // restarted, as a client that started before takes one that did.
    expect(await handshake(running, after, "db")).toBe("verified");
    const restarted = {
      cert: await read("db", "db_cert.pem"),
      key: await read("db", "db_key.pem"),
    };
    expect(restarted.cert).not.toBe(running.cert);
    expect(await handshake(restarted, before, "db")).toBe("verified");
  });

  it("refuses a service that another instance's authority vouches for", async () => {
    const mine = await settings();
    const theirs = await settings();
    const out = (options: TlsSettings) => join(options.TLS_DIR, "..", "certs");
    for (const options of [mine, theirs]) {
      await issueServiceCertificates(
        options,
        [{ name: "db", postgres: true }],
        out(options),
        quiet,
      );
    }
    const served = {
      cert: await readFile(join(out(theirs), "db", "db_cert.pem"), "utf8"),
      key: await readFile(join(out(theirs), "db", "db_key.pem"), "utf8"),
    };
    const trusted = await readFile(
      join(out(mine), "internal-authority.crt"),
      "utf8",
    );
    expect(await handshake(served, trusted, "db")).not.toBe("verified");
  });

  it("renews the internal authority in its last year without a new key", async () => {
    const options = await settings();
    const out = join(options.TLS_DIR, "..", "certs");
    const services = [{ name: "db", postgres: true }];
    const first = await issueServiceCertificates(options, services, out, quiet);
    const running = new X509Certificate(
      await readFile(join(out, "db", "db_cert.pem"), "utf8"),
    );
    // Nine years and a half on, the authority is in its last year.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 9.5 * 365 * 86_400_000);
      const said: string[] = [];
      const renewed = await issueServiceCertificates(
        options,
        services,
        out,
        (line) => said.push(line),
      );
      expect(renewed.fingerprint).not.toBe(first.fingerprint);
      expect(said.join(" ")).toMatch(/renew/i);
      const authority = new X509Certificate(
        await readFile(join(out, "internal-authority.crt"), "utf8"),
      );
      expect(new Date(authority.validTo).getTime()).toBeGreaterThan(
        Date.now() + 9 * 365 * 86_400_000,
      );
      // The certificate a service loaded before is still its own.
      expect(running.checkIssued(authority)).toBe(true);
      expect(running.verify(authority.publicKey)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
