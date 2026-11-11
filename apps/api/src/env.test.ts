import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isLoopback, readEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://anygriddb:secret@localhost:5432/anygriddb",
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("readEnv", () => {
  it("rejects a missing or short encryption key", () => {
    expect(() => readEnv({ ...base, AUTH_ENCRYPTION_KEY: "" })).toThrow(
      /AUTH_ENCRYPTION_KEY is required/,
    );
    expect(() =>
      readEnv({
        ...base,
        AUTH_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      }),
    ).toThrow(/32 bytes/);
  });

  it("accepts a 32-byte key", () => {
    const env = readEnv(base);
    expect(env.AUTH_ENCRYPTION_KEY).toHaveLength(32);
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
  });

  it("keeps the origin of PUBLIC_URL, falling back to WEB_ORIGIN", () => {
    expect(readEnv(base).PUBLIC_URL).toBe("https://localhost:4000");
    expect(
      readEnv({ ...base, PUBLIC_URL: "https://grid.example.org/" }).PUBLIC_URL,
    ).toBe("https://grid.example.org");
    expect(
      readEnv({ ...base, WEB_ORIGIN: "https://old.example.org:8443" })
        .PUBLIC_URL,
    ).toBe("https://old.example.org:8443");
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
