import { describe, expect, it } from "vitest";
import { readEnv } from "./env.js";
import { endpointHost, operatorFixedFromEnv } from "./operator-fixed.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("operatorFixedFromEnv", () => {
  it("exposes public URL, disk path, and trusted proxies without secrets", () => {
    const env = readEnv({
      DATABASE_URL: "postgresql://anygriddb:secret@127.0.0.1:5432/anygriddb",
      AUTH_ENCRYPTION_KEY: key,
      PUBLIC_URL: "https://grid.example.org",
      STORAGE_DRIVER: "disk",
      STORAGE_PATH: "/var/lib/anygriddb/files",
      ANYGRIDDB_TRUSTED_PROXIES: "192.0.2.0/24, 198.51.100.10",
      SMTP_PASSWORD: "never-show",
      S3_SECRET_KEY: "also-never",
    });
    const fixed = operatorFixedFromEnv(env);
    expect(fixed).toEqual({
      publicUrl: "https://grid.example.org",
      storage: { driver: "disk", path: "/var/lib/anygriddb/files" },
      trustedProxies: ["192.0.2.0/24", "198.51.100.10"],
    });
    const json = JSON.stringify(fixed);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("never-show");
    expect(json).not.toContain("also-never");
    expect(json).not.toContain(key);
  });

  it("names the S3 bucket and host without keys or a KMS id", () => {
    const env = readEnv({
      DATABASE_URL: "postgresql://anygriddb:secret@127.0.0.1:5432/anygriddb",
      AUTH_ENCRYPTION_KEY: key,
      PUBLIC_URL: "https://grid.example.org",
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "https://s3.example.org:9000",
      S3_REGION: "eu-west-1",
      S3_ACCESS_KEY: "access-never-shown",
      S3_SECRET_KEY: "secret-never-shown",
      S3_BUCKET: "anygriddb-files",
      S3_SERVER_SIDE_ENCRYPTION: "aws:kms",
      S3_KMS_KEY_ID: "kms-key-never-shown",
    });
    const fixed = operatorFixedFromEnv(env);
    expect(fixed.storage).toEqual({
      driver: "s3",
      bucket: "anygriddb-files",
      endpointHost: "s3.example.org:9000",
      region: "eu-west-1",
      encryption: "aws:kms",
    });
    const json = JSON.stringify(fixed);
    expect(json).not.toContain("access-never-shown");
    expect(json).not.toContain("secret-never-shown");
    expect(json).not.toContain("kms-key-never-shown");
  });
});

describe("endpointHost", () => {
  it("keeps the host of a valid URL and drops junk", () => {
    expect(endpointHost("https://files.example.org/path")).toBe(
      "files.example.org",
    );
    expect(endpointHost("not a url")).toBeNull();
    expect(endpointHost(undefined)).toBeNull();
  });
});
