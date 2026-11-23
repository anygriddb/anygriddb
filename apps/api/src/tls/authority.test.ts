import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyRing, mintKey, parseKeyRing } from "../auth/key-ring.js";
import {
  issueApplicationPassword,
  issueServiceCertificates,
  loadTls,
  refreshTls,
  resealTlsKey,
  resetTlsFolder,
  sealedBy,
  serverNames,
  TLS_CHECK_MS,
  TlsKeyUnreadable,
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

  it("seals its keys under a new key at the next start, and keeps its authority", async () => {
    const earlier = randomBytes(32);
    const options = {
      ...(await settings()),
      AUTH_ENCRYPTION_KEY: keyRing(earlier),
    };
    const out = join(options.TLS_DIR, "..", "certs");
    const services = [{ name: "db", postgres: true }];
    const first = await issueServiceCertificates(options, services, out, quiet);
    await loadTls(options, quiet);
    expect(await sealedBy(options.TLS_DIR, "internal-authority.key.enc")).toBe(
      "0",
    );

    const next = mintKey("next");
    const during = parseKeyRing(next, `0:${earlier.toString("base64")}`);
    const notes: string[] = [];
    const again = await issueServiceCertificates(
      { ...options, AUTH_ENCRYPTION_KEY: during },
      services,
      out,
      (note) => notes.push(note),
    );
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(notes.join(" ")).toContain("internal-authority.key.enc");
    expect(await sealedBy(options.TLS_DIR, "internal-authority.key.enc")).toBe(
      "next",
    );

    // The earlier key can go: every key of the folder opens without it.
    const after = parseKeyRing(next);
    for (const name of [
      "authority.key.enc",
      "server.key.enc",
      "internal-authority.key.enc",
    ]) {
      expect(await resealTlsKey(options.TLS_DIR, name, after, false)).toEqual({
        keyId: "next",
        rewritten: false,
      });
    }
    const last = await issueServiceCertificates(
      { ...options, AUTH_ENCRYPTION_KEY: after },
      services,
      out,
      quiet,
    );
    expect(last.fingerprint).toBe(first.fingerprint);
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

/** Every file of the folder and what it holds, to prove none was touched. */
async function sums(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(dir)).sort();
  const entries = await Promise.all(
    names.map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(join(dir, name)))
        .digest("hex"),
    ]),
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

describe("a private key no key given opens", () => {
  const services = [{ name: "db", postgres: true }];
  const started = async () => {
    const options = await settings();
    const out = join(options.TLS_DIR, "..", "certs");
    await issueServiceCertificates(options, services, out, quiet);
    await loadTls(options, quiet);
    return { options, out, before: await sums(options.TLS_DIR) };
  };

  it("stops the instance and its services under another key, writing nothing", async () => {
    const { options, out, before } = await started();
    const other = {
      ...options,
      AUTH_ENCRYPTION_KEY: parseKeyRing(mintKey("x")),
    };
    await expect(loadTls(other, quiet)).rejects.toBeInstanceOf(
      TlsKeyUnreadable,
    );
    await expect(
      issueServiceCertificates(other, services, out, quiet),
    ).rejects.toBeInstanceOf(TlsKeyUnreadable);
    expect(await sums(options.TLS_DIR)).toEqual(before);
    // The right key is put back: the same authority, nothing to install.
    const again = await loadTls(options, quiet);
    expect(await sums(options.TLS_DIR)).toEqual(before);
    expect(again.mode).toBe("local");
  });

  it("says what to do, and nothing of the key", async () => {
    const { options } = await started();
    const key = parseKeyRing(mintKey("x"));
    const refused = await loadTls(
      { ...options, AUTH_ENCRYPTION_KEY: key },
      quiet,
    ).catch((error: unknown) => error as Error);
    expect((refused as Error).message).toContain("authority.key.enc");
    expect((refused as Error).message).toContain(
      "AUTH_ENCRYPTION_PREVIOUS_KEYS",
    );
    expect((refused as Error).message).toContain("anygriddb tls reset --yes");
  });

  it.each(["authority.key.enc", "internal-authority.key.enc"])(
    "refuses %s damaged or emptied, before the services' certificates",
    async (name) => {
      for (const damage of [
        "",
        "{}",
        "not json",
        '{"nonce":"AA==","ciphertext":"AA=="}',
      ]) {
        const { options, out } = await started();
        await writeFile(join(options.TLS_DIR, name), damage);
        const before = await sums(options.TLS_DIR);
        await expect(
          issueServiceCertificates(options, services, out, quiet),
        ).rejects.toBeInstanceOf(TlsKeyUnreadable);
        expect(await sums(options.TLS_DIR)).toEqual(before);
      }
    },
  );

  it("leaves a good key alone when the other authority's cannot be opened", async () => {
    const earlier = randomBytes(32);
    const options = {
      ...(await settings()),
      AUTH_ENCRYPTION_KEY: keyRing(earlier),
    };
    const out = join(options.TLS_DIR, "..", "certs");
    await issueServiceCertificates(options, services, out, quiet);
    await loadTls(options, quiet);
    await writeFile(join(options.TLS_DIR, "internal-authority.key.enc"), "{}");
    const before = await sums(options.TLS_DIR);
    // The authority's file opens under the earlier key and would be
    // sealed again: not while the other stops the start.
    const during = parseKeyRing(
      mintKey("next"),
      `0:${earlier.toString("base64")}`,
    );
    await expect(
      issueServiceCertificates(
        { ...options, AUTH_ENCRYPTION_KEY: during },
        services,
        out,
        quiet,
      ),
    ).rejects.toBeInstanceOf(TlsKeyUnreadable);
    expect(await sums(options.TLS_DIR)).toEqual(before);
  });

  it("is not stopped by a public authority the operator's certificate replaced", async () => {
    const { options, out } = await started();
    await writeFile(join(options.TLS_DIR, "authority.key.enc"), "{}");
    const before = await sums(options.TLS_DIR);
    const notes: string[] = [];
    await issueServiceCertificates(
      { ...options, TLS_CERT_FILE: "/own-tls/server.crt" },
      services,
      out,
      (note) => notes.push(note),
    );
    expect((await sums(options.TLS_DIR))["authority.key.enc"]).toBe(
      before["authority.key.enc"],
    );
    expect(notes.join(" ")).toContain("authority.key.enc");
    // Without that certificate it is the one in use, and it stops the start.
    await expect(
      issueServiceCertificates(options, services, out, quiet),
    ).rejects.toBeInstanceOf(TlsKeyUnreadable);
  });

  it("opens under an earlier key kept in the ring, and seals it again", async () => {
    const earlier = randomBytes(32);
    const options = {
      ...(await settings()),
      AUTH_ENCRYPTION_KEY: keyRing(earlier),
    };
    const first = await loadTls(options, quiet);
    const during = parseKeyRing(
      mintKey("next"),
      `0:${earlier.toString("base64")}`,
    );
    const again = await loadTls(
      { ...options, AUTH_ENCRYPTION_KEY: during },
      quiet,
    );
    expect(again.authority?.fingerprint).toBe(first.authority?.fingerprint);
    expect(
      await resealTlsKey(options.TLS_DIR, "authority.key.enc", during, true),
    ).toEqual({ keyId: "next", rewritten: true });
  });

  it("issues an authority when there is no key file at all", async () => {
    const options = await settings();
    const state = await loadTls(options, quiet);
    expect(state.authority?.fingerprint).toBeTruthy();
  });

  it("replaces a server key it cannot open: the authority vouches for the next", async () => {
    const options = await settings();
    const first = await loadTls(options, quiet);
    await writeFile(join(options.TLS_DIR, "server.key.enc"), "{}");
    const again = await loadTls(options, quiet);
    expect(again.authority?.fingerprint).toBe(first.authority?.fingerprint);
    expect(again.server.fingerprint).not.toBe(first.server.fingerprint);
  });

  it("sets the files aside for whoever really lost the key, and starts anew", async () => {
    const { options, out, before } = await started();
    const other = {
      ...options,
      AUTH_ENCRYPTION_KEY: parseKeyRing(mintKey("x")),
    };
    const { moved, folder } = await resetTlsFolder(options.TLS_DIR);
    expect(moved).toEqual(expect.arrayContaining(Object.keys(before)));
    const kept = await sums(join(options.TLS_DIR, folder ?? ""));
    expect(kept).toEqual(before);
    const fresh = await issueServiceCertificates(other, services, out, quiet);
    const state = await loadTls(other, quiet);
    expect(fresh.fingerprint).toBeTruthy();
    expect(state.authority?.fingerprint).toBeTruthy();
  });

  it("has nothing to set aside in a folder that does not exist", async () => {
    const options = await settings();
    expect(await resetTlsFolder(options.TLS_DIR)).toEqual({
      moved: [],
      folder: null,
    });
  });
});

describe("processes that start together, or stopped halfway", () => {
  it("settles on one authority when several start on an empty folder", async () => {
    const options = await settings();
    const states = await Promise.all(
      Array.from({ length: 8 }, () => loadTls(options, quiet)),
    );
    const prints = new Set(states.map((state) => state.authority?.fingerprint));
    expect(prints.size).toBe(1);
    const after = await loadTls(options, quiet);
    expect(after.authority?.fingerprint).toBe(
      states[0]?.authority?.fingerprint,
    );
    for (const state of states) {
      const authority = state.authority?.cert ?? "";
      expect(await handshake(state, authority, "grid.lan")).toBe("verified");
    }
    expect(
      await handshake(after, states[0]?.authority?.cert ?? "", "grid.lan"),
    ).toBe("verified");
  });

  it("makes the certificate again from the key when it is missing", async () => {
    const options = await settings();
    const first = await loadTls(options, quiet);
    await rm(join(options.TLS_DIR, "authority.crt"));
    const again = await loadTls(options, quiet);
    expect(
      new X509Certificate(again.authority?.cert ?? "").publicKey.equals(
        new X509Certificate(first.authority?.cert ?? "").publicKey,
      ),
    ).toBe(true);
    expect(
      await handshake(again, again.authority?.cert ?? "", "grid.lan"),
    ).toBe("verified");
  });

  it("serves no key beside a certificate that is not its own", async () => {
    const options = await settings();
    const first = await loadTls(options, quiet);
    const other = await settings();
    await loadTls(other, quiet);
    // The server's certificate of another process, beside this key.
    await writeFile(
      join(options.TLS_DIR, "authority.crt"),
      await readFile(join(other.TLS_DIR, "authority.crt")),
    );
    const again = await loadTls(options, quiet);
    expect(
      new X509Certificate(again.authority?.cert ?? "").publicKey.equals(
        new X509Certificate(first.authority?.cert ?? "").publicKey,
      ),
    ).toBe(true);
    expect(
      await handshake(again, again.authority?.cert ?? "", "grid.lan"),
    ).toBe("verified");
  });

  it("does not serve a server certificate with another's key", async () => {
    const options = await settings();
    await loadTls(options, quiet);
    const twin = await settings();
    await rm(twin.TLS_DIR, { recursive: true, force: true });
    const kept = await readFile(join(options.TLS_DIR, "server.key.enc"));
    await rm(join(options.TLS_DIR, "server.crt"));
    await loadTls(options, quiet);
    await writeFile(join(options.TLS_DIR, "server.key.enc"), kept);
    const again = await loadTls(options, quiet);
    expect(
      await handshake(again, again.authority?.cert ?? "", "grid.lan"),
    ).toBe("verified");
  });
});

describe("the operator's certificate, replaced", () => {
  const pair = async (options: TlsSettings, name: string) => {
    const issued = issueAuthority({ commonName: name, names: ["grid.lan"] });
    const certFile = join(options.TLS_DIR, "..", "own.crt");
    const keyFile = join(options.TLS_DIR, "..", "own.key");
    await writeFile(certFile, issued.cert);
    await writeFile(keyFile, issued.key);
    return { certFile, keyFile, issued };
  };

  it("is looked at every minute", () => {
    expect(TLS_CHECK_MS).toBe(60_000);
  });

  it("is served from the next check", async () => {
    const options = await settings();
    const { certFile, keyFile } = await pair(options, "first");
    const own = { ...options, TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile };
    const current = await loadTls(own, quiet);
    expect(await refreshTls(own, current, quiet)).toBe(current);
    const next = await pair(options, "second");
    const later = new Date(Date.now() + 5_000);
    await utimes(next.certFile, later, later);
    const fresh = await refreshTls(own, current, quiet);
    expect(fresh).not.toBe(current);
    expect(fresh.server.fingerprint).not.toBe(current.server.fingerprint);
  });

  it("keeps the certificate served when the new pair does not match", async () => {
    const options = await settings();
    const { certFile, keyFile } = await pair(options, "first");
    const own = { ...options, TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile };
    const current = await loadTls(own, quiet);
    const stray = issueAuthority({ commonName: "stray", names: ["grid.lan"] });
    await writeFile(keyFile, stray.key);
    const later = new Date(Date.now() + 5_000);
    await utimes(keyFile, later, later);
    await expect(refreshTls(own, current, quiet)).rejects.toThrow(
      /not the key/,
    );
  });
});

describe("the password of the application's role", () => {
  const db = { name: "db" };
  const app = { name: "app" };

  it("is made once, the same for both, and each copy is its service's", async () => {
    const out = await mkdtemp(join(tmpdir(), "anygriddb-role-"));
    dirs.push(out);
    const forDatabase = join(out, "db", "app_password");
    const forApplication = join(out, "app", "db_password");
    await issueApplicationPassword(out, db, app);
    const made = await readFile(forDatabase, "utf8");
    expect(made).toMatch(/^[0-9a-f]{64}\n$/);
    expect(await readFile(forApplication, "utf8")).toBe(made);
    expect((await stat(forDatabase)).mode & 0o777).toBe(0o400);
    expect((await stat(forApplication)).mode & 0o777).toBe(0o400);

    await issueApplicationPassword(out, db, app);
    expect(await readFile(forDatabase, "utf8")).toBe(made);
  });

  it("comes back from the one copy left", async () => {
    const out = await mkdtemp(join(tmpdir(), "anygriddb-role-"));
    dirs.push(out);
    await issueApplicationPassword(out, db, app);
    const forDatabase = join(out, "db", "app_password");
    const forApplication = join(out, "app", "db_password");
    const made = await readFile(forDatabase, "utf8");
    await rm(forApplication);
    await issueApplicationPassword(out, db, app);
    expect(await readFile(forApplication, "utf8")).toBe(made);
  });
});
