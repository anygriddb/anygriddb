import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES_CEILING } from "@anygriddb/core";
import {
  databasePasswordHint,
  isLoopback,
  readEnv,
  readFileSettings,
  readSyslogCollector,
  secretFromEnv,
  strictInteger,
} from "./env.js";

const base = {
  DATABASE_URL: "postgres://anygriddb:secret@localhost:5432/anygriddb",
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("secretFromEnv", () => {
  it("reads NAME, or NAME_FILE, and refuses both", () => {
    const dir = mkdtempSync(join(tmpdir(), "anygriddb-secret-"));
    const path = join(dir, "token");
    writeFileSync(path, "from-file-value\n", "utf8");
    expect(secretFromEnv({ TOKEN: "from-env" }, "TOKEN")).toBe("from-env");
    expect(secretFromEnv({ TOKEN_FILE: path }, "TOKEN")).toBe(
      "from-file-value",
    );
    // A Compose file passes a name it lists empty when nothing sets it:
    // empty is unset, and the file is read.
    expect(secretFromEnv({ TOKEN: "", TOKEN_FILE: path }, "TOKEN")).toBe(
      "from-file-value",
    );
    expect(() =>
      secretFromEnv({ TOKEN: "from-env", TOKEN_FILE: path }, "TOKEN"),
    ).toThrow(/TOKEN and TOKEN_FILE cannot both be set/);
    expect(secretFromEnv({}, "TOKEN")).toBeUndefined();
  });
});

describe("readEnv", () => {
  it("rejects a missing or short encryption key", () => {
    expect(() => readEnv({ ...base, AUTH_ENCRYPTION_KEY: "" })).toThrow(
      /AUTH_ENCRYPTION_KEY or AUTH_ENCRYPTION_KEY_FILE is required/,
    );
    expect(() =>
      readEnv({
        ...base,
        AUTH_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      }),
    ).toThrow(/32 bytes/);
  });

  it("accepts a 32-byte key, alone or named, and the earlier keys kept", () => {
    const env = readEnv(base);
    expect(env.AUTH_ENCRYPTION_KEY.currentId).toBe("0");
    expect([...env.AUTH_ENCRYPTION_KEY.masters.keys()]).toEqual(["0"]);
    const changed = readEnv({
      ...base,
      AUTH_ENCRYPTION_KEY: `20261113:${randomBytes(32).toString("base64")}`,
      AUTH_ENCRYPTION_PREVIOUS_KEYS: `0:${base.AUTH_ENCRYPTION_KEY}`,
    });
    expect(changed.AUTH_ENCRYPTION_KEY.currentId).toBe("20261113");
    expect([...changed.AUTH_ENCRYPTION_KEY.masters.keys()]).toEqual([
      "20261113",
      "0",
    ]);
    expect(() =>
      readEnv({ ...base, AUTH_ENCRYPTION_PREVIOUS_KEYS: "old:c2hvcnQ=" }),
    ).toThrow(/AUTH_ENCRYPTION_PREVIOUS_KEYS must be 32 bytes/);
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
  });

  it("reads DATABASE_URL and AUTH_ENCRYPTION_KEY from files", () => {
    const dir = mkdtempSync(join(tmpdir(), "anygriddb-env-"));
    const key = randomBytes(32).toString("base64");
    const url = "postgres://anygriddb:secret@localhost:5432/anygriddb";
    const keyPath = join(dir, "key");
    const urlPath = join(dir, "url");
    writeFileSync(keyPath, `${key}\n`, "utf8");
    writeFileSync(urlPath, `${url}\n`, "utf8");
    const env = readEnv({
      DATABASE_URL_FILE: urlPath,
      AUTH_ENCRYPTION_KEY_FILE: keyPath,
    });
    expect(env.DATABASE_URL).toBe(url);
    expect(env.AUTH_ENCRYPTION_KEY.currentId).toBe("0");
    expect(() =>
      readEnv({
        ...base,
        DATABASE_URL_FILE: urlPath,
      }),
    ).toThrow(/DATABASE_URL and DATABASE_URL_FILE cannot both be set/);
  });

  it("keeps the origin of PUBLIC_URL, and refuses the name it replaced", () => {
    expect(readEnv(base).PUBLIC_URL).toBe("https://localhost:4000");
    expect(
      readEnv({ ...base, PUBLIC_URL: "https://grid.example.org/" }).PUBLIC_URL,
    ).toBe("https://grid.example.org");
    // Ignored, an instance that still sets it alone would start on localhost.
    expect(() =>
      readEnv({ ...base, WEB_ORIGIN: "https://old.example.org:8443" }),
    ).toThrow(/WEB_ORIGIN is no longer read: set PUBLIC_URL/);
    expect(
      readEnv({
        ...base,
        PUBLIC_URL: "https://grid.example.org",
        WEB_ORIGIN: "https://old.example.org:8443",
      }).PUBLIC_URL,
    ).toBe("https://grid.example.org");
    for (const PUBLIC_URL of [
      "grid.example.org",
      "ftp://grid.example.org",
      "https://example.org/grid",
    ]) {
      expect(() => readEnv({ ...base, PUBLIC_URL })).toThrow(/PUBLIC_URL/);
    }
  });

  it("serves HTTPS only: plain HTTP names the development server alone", () => {
    expect(
      readEnv({ ...base, PUBLIC_URL: "http://localhost:3000" }).PUBLIC_URL,
    ).toBe("http://localhost:3000");
    for (const PUBLIC_URL of [
      "http://192.168.1.10:3000",
      "http://grid.example.org",
    ]) {
      expect(() => readEnv({ ...base, PUBLIC_URL })).toThrow(/https/);
    }
  });

  it("takes the operator's certificate as a pair, and extra names", () => {
    expect(() => readEnv({ ...base, TLS_CERT_FILE: "/tls/grid.crt" })).toThrow(
      /go together/,
    );
    const env = readEnv({
      ...base,
      TLS_CERT_FILE: "/tls/grid.crt",
      TLS_KEY_FILE: "/tls/grid.key",
      TLS_NAMES: "grid.corp, 10.0.0.5",
    });
    expect(env.TLS_CERT_FILE).toBe("/tls/grid.crt");
    expect(env.TLS_NAMES).toEqual(["grid.corp", "10.0.0.5"]);
    expect(() => readEnv({ ...base, TLS_NAMES: "a/b" })).toThrow(/TLS_NAMES/);
  });

  it("names the port it refuses: its own, or the mail relay's", () => {
    expect(readEnv({ ...base, PORT: "4100", SMTP_PORT: "587" })).toMatchObject({
      PORT: 4100,
      SMTP_PORT: 587,
    });
    expect(() => readEnv({ ...base, PORT: "70000" })).toThrow(/^PORT must be/);
    expect(() => readEnv({ ...base, SMTP_PORT: "smtp" })).toThrow(
      /^SMTP_PORT must be/,
    );
    expect(() => readEnv({ ...base, SMTP_PORT: "70000" })).toThrow(
      /^SMTP_PORT must be/,
    );
  });

  it("sizes the request pool within bounds", () => {
    expect(readEnv(base).DATABASE_POOL_MAX).toBe(10);
    expect(
      readEnv({ ...base, DATABASE_POOL_MAX: "24" }).DATABASE_POOL_MAX,
    ).toBe(24);
    for (const refused of ["3", "65", "ten", "12.5"]) {
      expect(() => readEnv({ ...base, DATABASE_POOL_MAX: refused })).toThrow(
        "DATABASE_POOL_MAX must be an integer between 4 and 64",
      );
    }
  });

  it("bounds the rows an export job writes", () => {
    expect(readEnv(base).EXPORT_MAX_ROWS).toBe(1_000_000);
    expect(
      readEnv({ ...base, EXPORT_MAX_ROWS: "250000" }).EXPORT_MAX_ROWS,
    ).toBe(250_000);
    for (const refused of ["99999", "10000001", "lots"]) {
      expect(() => readEnv({ ...base, EXPORT_MAX_ROWS: refused })).toThrow(
        "EXPORT_MAX_ROWS must be an integer between 100000 and 10000000",
      );
    }
  });

  it("bounds the rows one imported file may hold", () => {
    expect(readEnv(base).IMPORT_MAX_ROWS).toBe(1_000_000);
    expect(
      readEnv({ ...base, IMPORT_MAX_ROWS: "2000000" }).IMPORT_MAX_ROWS,
    ).toBe(2_000_000);
    expect(() => readEnv({ ...base, IMPORT_MAX_ROWS: "5000" })).toThrow(
      "IMPORT_MAX_ROWS must be an integer between 100000 and 10000000",
    );
  });

  it("refuses plaintext sources in production", () => {
    expect(() =>
      readEnv({
        ...base,
        NODE_ENV: "production",
        ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT: "true",
      }),
    ).toThrow(/development/);
  });
});

/** What a refused DATABASE_URL is answered, or nothing when it is taken. */
function saidBy(address: string): string {
  try {
    readEnv({ ...base, DATABASE_URL: address });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("connections AnyGridDB opens", () => {
  it("reaches its PostgreSQL over verified TLS beyond this machine", () => {
    const remote = "postgres://anygriddb:secret@db:5432/anygriddb";
    expect(() => readEnv({ ...base, DATABASE_URL: remote })).toThrow(
      /verified TLS/,
    );
    for (const DATABASE_URL of [
      `${remote}?sslmode=disable`,
      `${remote}?sslmode=prefer`,
      `${remote}?sslmode=no-verify`,
      `${remote}?sslmode=require&uselibpqcompat=true`,
    ]) {
      expect(() => readEnv({ ...base, DATABASE_URL }), DATABASE_URL).toThrow(
        /verified TLS/,
      );
    }
    for (const DATABASE_URL of [
      `${remote}?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt`,
      `${remote}?sslmode=require`,
      "postgres://anygriddb:secret@127.0.0.1:5432/anygriddb",
      "postgres://anygriddb@/anygriddb?host=/var/run/postgresql",
    ]) {
      expect(readEnv({ ...base, DATABASE_URL }).DATABASE_URL).toBe(
        DATABASE_URL,
      );
    }
  });

  it("says so when a password cuts its PostgreSQL's address short", () => {
    const address = (password: string) =>
      `postgres://anygriddb:${password}@db:5432/anygriddb?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt`;
    // As typed in `.env`: a `/` (every other password in base64), a `?`
    // or a `#`, wherever it stands, digits before it or nothing at all.
    for (const password of [
      "abc/def",
      "/abc",
      "5432/abc",
      "abc?def",
      "?abc",
      "abc#def",
      "abc#",
    ]) {
      expect(
        () => readEnv({ ...base, DATABASE_URL: address(password) }),
        password,
      ).toThrow(/^DATABASE_URL cannot be read as an address/);
    }
    // Never a word of the address in what is said.
    expect(saidBy(address("s3cret/part"))).not.toMatch(
      /s3cret|part|db:5432|anygriddb/,
    );
    // Every other character, and the three once percent-encoded.
    for (const password of [
      "0123456789abcdef",
      "p@ss:w&rd;+=!$'",
      "abc%2Fdef%3Fghi%23",
    ]) {
      expect(
        readEnv({ ...base, DATABASE_URL: address(password) }).DATABASE_URL,
      ).toBe(address(password));
    }
    // A database whose name holds an `@` is one, not a host.
    expect(
      readEnv({
        ...base,
        DATABASE_URL: "postgres://anygriddb:secret@localhost/team@work",
      }).DATABASE_URL,
    ).toBe("postgres://anygriddb:secret@localhost/team@work");
  });

  it("reads the host after the last @, never a piece of the password", () => {
    // On this machine, the address needs no TLS whatever its password.
    const local = "postgres://anygriddb:p@s3cret@127.0.0.1:5432/anygriddb";
    expect(readEnv({ ...base, DATABASE_URL: local }).DATABASE_URL).toBe(local);
    // Beyond it, the refusal names the host, which is no secret.
    const said = saidBy("postgres://anygriddb:p@s3cret@db:5432/anygriddb");
    expect(said).toMatch(/^DATABASE_URL reaches db over the network/);
    expect(said).not.toMatch(/s3cret/);
  });

  it("calls S3 and SAML over https://, but on the loopback", () => {
    const s3 = {
      ...base,
      S3_ACCESS_KEY: "a",
      S3_SECRET_KEY: "b",
      S3_BUCKET: "files",
    };
    expect(() => readEnv({ ...s3, S3_ENDPOINT: "http://rustfs:9000" })).toThrow(
      /S3_ENDPOINT/,
    );
    expect(
      readEnv({ ...s3, S3_ENDPOINT: "https://rustfs:9000" }).S3_ENDPOINT,
    ).toBe("https://rustfs:9000");
    expect(
      readEnv({ ...s3, S3_ENDPOINT: "http://127.0.0.1:9000" }).S3_ENDPOINT,
    ).toBe("http://127.0.0.1:9000");
    expect(() =>
      readEnv({ ...base, SAML_ENTRY_POINT: "http://idp.example/sso" }),
    ).toThrow(/SAML_ENTRY_POINT/);
  });

  it("asks S3 for server-side encryption only as the operator says", () => {
    const s3 = {
      ...base,
      S3_ENDPOINT: "https://s3.example.com",
      S3_ACCESS_KEY: "a",
      S3_SECRET_KEY: "b",
      S3_BUCKET: "files",
    };
    expect(readEnv(s3).S3_SERVER_SIDE_ENCRYPTION).toBeUndefined();
    expect(
      readEnv({ ...s3, S3_SERVER_SIDE_ENCRYPTION: "AES256" })
        .S3_SERVER_SIDE_ENCRYPTION,
    ).toBe("AES256");
    expect(
      readEnv({
        ...s3,
        S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
        S3_KMS_KEY_ID: "alias/anygriddb",
      }),
    ).toMatchObject({
      S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
      S3_KMS_KEY_ID: "alias/anygriddb",
    });
    expect(() => readEnv({ ...s3, S3_SERVER_SIDE_ENCRYPTION: "yes" })).toThrow(
      /S3_SERVER_SIDE_ENCRYPTION/,
    );
    expect(() => readEnv({ ...s3, S3_KMS_KEY_ID: "alias/anygriddb" })).toThrow(
      /S3_KMS_KEY_ID/,
    );
  });
});

describe("isLoopback", () => {
  it("knows the hosts on this machine only", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "[::1]"]) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ["192.168.1.10", "grid.internal", "localhost.example"]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it("serves metrics for a long token only, and sends spans over TLS only", () => {
    expect(readEnv(base).METRICS_TOKEN).toBeUndefined();
    expect(() => readEnv({ ...base, METRICS_TOKEN: "short" })).toThrow(
      "METRICS_TOKEN must be 32 characters or more",
    );
    expect(
      readEnv({ ...base, METRICS_TOKEN: "m".repeat(40) }).METRICS_TOKEN,
    ).toBe("m".repeat(40));
    expect(readEnv(base).OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(() =>
      readEnv({
        ...base,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318",
      }),
    ).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(
      readEnv({
        ...base,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
      }).OTEL_EXPORTER_OTLP_ENDPOINT,
    ).toBe("https://collector.internal:4318");
  });

  it("sends sign-in events to a syslog collector only when one is named", () => {
    expect(readEnv(base).SYSLOG).toBeUndefined();
    expect(
      readEnv({ ...base, SYSLOG_HOST: "logs.example.org" }).SYSLOG,
    ).toEqual({ host: "logs.example.org", port: 6514 });
    // A value that names no collector stops the start, saying which.
    expect(() =>
      readEnv({ ...base, SYSLOG_HOST: "udp://logs.example.org" }),
    ).toThrow("SYSLOG_HOST must be a host name or an address");
    expect(() => readEnv({ ...base, SYSLOG_PORT: "6514" })).toThrow(
      "SYSLOG_PORT and SYSLOG_CA_FILE need SYSLOG_HOST",
    );
  });

  it("trusts no proxy unless the operator lists addresses or ranges", () => {
    expect(readEnv(base).TRUSTED_PROXIES).toEqual([]);
    expect(
      readEnv({
        ...base,
        ANYGRIDDB_TRUSTED_PROXIES: " 127.0.0.1, ::1 ,172.18.0.0/16, fd00::/8",
      }).TRUSTED_PROXIES,
    ).toEqual(["127.0.0.1", "::1", "172.18.0.0/16", "fd00::/8"]);
    for (const refused of [
      "proxy.internal",
      "10.0.0.0/33",
      "fd00::/129",
      "10.0.0.0/8/8",
      "10.0.0.0/",
    ]) {
      expect(() =>
        readEnv({ ...base, ANYGRIDDB_TRUSTED_PROXIES: refused }),
      ).toThrow(/ANYGRIDDB_TRUSTED_PROXIES/);
    }
  });
});

describe("readFileSettings", () => {
  // A Compose file passes every setting it names, empty when unset.
  const unset = {
    STORAGE_DRIVER: "",
    S3_ENDPOINT: "",
    S3_REGION: "",
    S3_ACCESS_KEY: "",
    S3_SECRET_KEY: "",
    S3_BUCKET: "",
    S3_SERVER_SIDE_ENCRYPTION: "",
    S3_KMS_KEY_ID: "",
  };

  it("keeps files on disk when every storage setting is empty", () => {
    const settings = readFileSettings(unset);
    expect(settings.STORAGE_DRIVER).toBe("disk");
    expect(settings.S3_ENDPOINT).toBeUndefined();
    expect(settings.S3_REGION).toBeUndefined();
    expect(settings.S3_BUCKET).toBeUndefined();
  });

  it("keeps them in the operator's store once its four settings are given", () => {
    const settings = readFileSettings({
      ...unset,
      S3_ENDPOINT: "https://objects.example.org",
      S3_ACCESS_KEY: "access",
      S3_SECRET_KEY: "secret",
      S3_BUCKET: "files",
    });
    expect(settings.STORAGE_DRIVER).toBe("s3");
    expect(() =>
      readFileSettings({ ...unset, S3_ENDPOINT: "http://objects.example.org" }),
    ).toThrow(/S3_ENDPOINT/);
  });
});

describe("whole numbers", () => {
  it("reads decimal digits", () => {
    expect(strictInteger("0")).toBe(0);
    expect(strictInteger("4")).toBe(4);
    expect(strictInteger("20971520")).toBe(20_971_520);
  });

  it.each([
    "",
    " ",
    " 5",
    "5 ",
    "5\n",
    "0x10",
    "1e3",
    "1.5",
    "-1",
    "+1",
    "12abc",
    "abc",
    "Infinity",
    "9007199254740993",
  ])("refuses %j", (raw) => {
    expect(strictInteger(raw)).toBeUndefined();
  });

  it("holds every number of the environment to it", () => {
    for (const [name, value] of [
      ["PORT", "0x10"],
      ["PORT", "1e3"],
      ["SMTP_PORT", "0x19"],
      ["DATABASE_POOL_MAX", "1e1"],
      ["WORKER_CONCURRENCY", "0x4"],
      ["UPLOAD_CONCURRENCY", " 8"],
      ["JOB_CONCURRENCY", "2.0"],
      ["EXPORT_MAX_ROWS", "1e6"],
      ["IMPORT_MAX_ROWS", "0x100000"],
    ] as const) {
      expect(() => readEnv({ ...base, [name]: value })).toThrow(name);
    }
    expect(() =>
      readSyslogCollector({
        SYSLOG_HOST: "log.example.org",
        SYSLOG_PORT: "1e3",
      }),
    ).toThrow("SYSLOG_PORT");
  });
});

describe("ATTACHMENT_MAX_BYTES", () => {
  it.each(["1024", "20971520", String(ATTACHMENT_MAX_BYTES_CEILING)])(
    "takes %s",
    (value) => {
      expect(
        readEnv({ ...base, ATTACHMENT_MAX_BYTES: value }).ATTACHMENT_MAX_BYTES,
      ).toBe(Number(value));
    },
  );

  it("is unset when Compose passes it empty", () => {
    expect(
      readEnv({ ...base, ATTACHMENT_MAX_BYTES: "" }).ATTACHMENT_MAX_BYTES,
    ).toBeUndefined();
  });

  it.each([
    "20MB",
    "10M",
    "abc",
    "0",
    "-5",
    "1.5",
    "1e30",
    "1e6",
    "0x10",
    "1023",
    String(ATTACHMENT_MAX_BYTES_CEILING + 1),
  ])("refuses %s, naming the variable", (value) => {
    expect(() => readEnv({ ...base, ATTACHMENT_MAX_BYTES: value })).toThrow(
      /ATTACHMENT_MAX_BYTES/,
    );
  });
});

describe("a secret's file that cannot be read", () => {
  const missing = join(tmpdir(), `anygriddb-${randomBytes(6).toString("hex")}`);

  it.each([
    "AUTH_ENCRYPTION_KEY",
    "AUTH_ENCRYPTION_PREVIOUS_KEYS",
    "DATABASE_URL",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "OIDC_CLIENT_SECRET",
    "SMTP_PASSWORD",
    "METRICS_TOKEN",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ])("names %s_FILE and its error, never the path", (name) => {
    let thrown: Error | undefined;
    try {
      secretFromEnv({ [`${name}_FILE`]: missing }, name);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain(`${name}_FILE`);
    expect(thrown?.message).toContain("ENOENT");
    expect(thrown?.message).not.toContain(missing);
    expect(thrown?.cause).toBeUndefined();
  });

  it("does the same for SYSLOG_CA_FILE", () => {
    let thrown: Error | undefined;
    try {
      readSyslogCollector({
        SYSLOG_HOST: "log.example.org",
        SYSLOG_CA_FILE: missing,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("SYSLOG_CA_FILE");
    expect(thrown?.message).toContain("ENOENT");
    expect(thrown?.message).not.toContain(missing);
    expect(thrown?.cause).toBeUndefined();
  });
});

describe("OIDC_ISSUER", () => {
  it("takes https, and http on this machine", () => {
    for (const issuer of [
      "https://idp.example.org/realms/grid",
      "http://localhost:8080/realms/grid",
      "http://127.0.0.1:8080/",
    ]) {
      expect(readEnv({ ...base, OIDC_ISSUER: issuer }).OIDC_ISSUER).toBe(
        issuer,
      );
    }
  });

  it("refuses http beyond this machine, naming the variable", () => {
    expect(() =>
      readEnv({ ...base, OIDC_ISSUER: "http://idp.example.org/realms/grid" }),
    ).toThrow(/OIDC_ISSUER must be an https/);
  });
});

describe("a password PostgreSQL refused", () => {
  const refused = Object.assign(new Error("refused"), { code: "28P01" });
  const at = (password: string) =>
    `postgres://grid:${password}@db.example.org:5432/grid?sslmode=verify-full`;

  it("says an escape in the address was decoded, without the password", () => {
    const hint = databasePasswordHint(at("abc%41def"), refused);
    expect(hint).toContain("%25");
    expect(hint).not.toContain("abc");
    expect(hint).not.toContain("def");
  });

  it("says nothing when no escape could have changed it", () => {
    expect(databasePasswordHint(at("abc%zzdef"), refused)).toBeUndefined();
    expect(databasePasswordHint(at("plain"), refused)).toBeUndefined();
    expect(
      databasePasswordHint(
        "postgres://grid:plain@db.example.org/grid%41?sslmode=verify-full",
        refused,
      ),
    ).toBeUndefined();
  });

  it("says nothing of another failure", () => {
    expect(
      databasePasswordHint(
        at("abc%41def"),
        Object.assign(new Error("gone"), { code: "57P01" }),
      ),
    ).toBeUndefined();
  });
});
