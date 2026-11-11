import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchBucket,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  assertFileKey,
  exactBytes,
  FILE_KEY,
  type FileEntry,
  type FileStore,
  type StoredFile,
} from "./store.js";

export type S3Config = {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

/** Wall time for one S3 HTTP round-trip (handler + AbortSignal). */
const REQUEST_TIMEOUT_MS = 60_000;
/** Time to open a TCP/TLS socket to the endpoint. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Any S3-compatible service: AWS, Scaleway, OVH, Ceph, Garage, SeaweedFS,
 * RustFS. Path-style addressing, so a bucket name needs no DNS entry.
 * Checksums are sent only where S3 requires them: the SDK's default adds
 * trailing checksums to streamed uploads, which many compatible services
 * refuse. The length of every upload is still fixed in advance.
 */
export class S3Store implements FileStore {
  readonly driver = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECT_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      }),
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertFileKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  }

  async putFile(key: string, file: StoredFile): Promise<void> {
    assertFileKey(key);
    const body = Readable.from(exactBytes(file.body, file.size));
    // The SDK pipes the body into the request without watching it: a
    // body that fails would leave the request waiting for its bytes.
    const abort = new AbortController();
    const wall = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    wall.addEventListener("abort", () => abort.abort(wall.reason), {
      once: true,
    });
    let fail: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    failed.catch(() => undefined);
    const onError = (error: Error) => {
      abort.abort(error);
      fail(error);
    };
    body.once("error", onError);
    try {
      await Promise.race([
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: body,
            ContentLength: file.size,
            ContentType: file.contentType,
          }),
          { abortSignal: abort.signal },
        ),
        failed,
      ]);
    } finally {
      body.off("error", onError);
      body.destroy();
    }
  }

  async open(key: string) {
    assertFileKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!(response.Body instanceof Readable)) return undefined;
      return {
        body: response.Body,
        contentType: response.ContentType ?? "application/octet-stream",
        size: response.ContentLength ?? 0,
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertFileKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  }

  async *list(): AsyncIterable<FileEntry> {
    let token: string | undefined;
    do {
      let page;
      try {
        page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            ContinuationToken: token,
          }),
          { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
      } catch (error) {
        // A bucket not created yet holds no files.
        if (error instanceof NoSuchBucket) return;
        throw error;
      }
      for (const item of page.Contents ?? []) {
        if (!item.Key || !FILE_KEY.test(item.Key)) continue;
        yield {
          key: item.Key,
          size: item.Size ?? 0,
          modifiedAt: item.LastModified ?? new Date(),
        };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /** A failed upload stores no object: nothing is ever left behind. */
  tidy(_before: Date): Promise<number> {
    return Promise.resolve(0);
  }

  /** Creates the bucket when it is missing. */
  async check(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    } catch {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    }
  }
}
