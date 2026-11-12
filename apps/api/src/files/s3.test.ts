import { Readable } from "node:stream";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Store, type S3Config } from "./s3.js";

const config: S3Config = {
  endpoint: "https://s3.example.com",
  region: "eu-west-3",
  accessKey: "a",
  secretKey: "b",
  bucket: "files",
};
const KEY = `att${"a".repeat(32)}`;

/** The inputs of the uploads a store sends, without a network. */
function uploads(): () => Array<Record<string, unknown>> {
  const send = vi
    .spyOn(S3Client.prototype, "send")
    .mockResolvedValue({} as never);
  return () =>
    send.mock.calls.flatMap(([command]) =>
      command instanceof PutObjectCommand ? [{ ...command.input }] : [],
    );
}

describe("S3Store uploads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks nothing of the service's encryption by default", async () => {
    const sent = uploads();
    await new S3Store(config).put(KEY, Buffer.from("x"), "text/plain");
    expect(sent()[0]).not.toHaveProperty("ServerSideEncryption");
    expect(sent()[0]).not.toHaveProperty("SSEKMSKeyId");
  });

  it("asks the service to encrypt each object when the operator says so", async () => {
    const sent = uploads();
    await new S3Store({ ...config, serverSideEncryption: "AES256" }).put(
      KEY,
      Buffer.from("x"),
      "text/plain",
    );
    await new S3Store({
      ...config,
      serverSideEncryption: "aws:kms",
      kmsKeyId: "alias/anygriddb",
    }).putFile(KEY, {
      body: Readable.from([Buffer.from("x")]),
      size: 1,
      contentType: "text/plain",
    });
    const [plain, kms] = sent();
    expect(plain).toMatchObject({ ServerSideEncryption: "AES256" });
    expect(plain).not.toHaveProperty("SSEKMSKeyId");
    expect(kms).toMatchObject({
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "alias/anygriddb",
    });
  });
});
