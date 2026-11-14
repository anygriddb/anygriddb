import { DiskStore } from "./disk.js";
import { S3Store } from "./s3.js";
import type { FileStore } from "./store.js";

export { DiskStore } from "./disk.js";
export * from "./store.js";

export type FileSettings = {
  STORAGE_DRIVER: "disk" | "s3";
  STORAGE_PATH: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_BUCKET?: string;
  S3_SERVER_SIDE_ENCRYPTION?: "AES256" | "aws:kms";
  S3_KMS_KEY_ID?: string;
};

export function createFileStore(settings: FileSettings): FileStore {
  if (settings.STORAGE_DRIVER === "disk") {
    return new DiskStore(settings.STORAGE_PATH);
  }
  if (
    !settings.S3_ENDPOINT ||
    !settings.S3_ACCESS_KEY ||
    !settings.S3_SECRET_KEY ||
    !settings.S3_BUCKET
  ) {
    throw new Error(
      "STORAGE_DRIVER=s3 needs S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, and S3_BUCKET",
    );
  }
  return new S3Store({
    endpoint: settings.S3_ENDPOINT,
    region: settings.S3_REGION || "us-east-1",
    accessKey: settings.S3_ACCESS_KEY,
    secretKey: settings.S3_SECRET_KEY,
    bucket: settings.S3_BUCKET,
    serverSideEncryption: settings.S3_SERVER_SIDE_ENCRYPTION,
    kmsKeyId: settings.S3_KMS_KEY_ID,
  });
}
