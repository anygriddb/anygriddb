/**
 * The instance's logo (ADR 0072): one image, in one row. An administrator
 * sets it from Administration, through the same guards as any setting;
 * everyone reads it, signed in or not, since the sign-in page shows it.
 */
import {
  AppError,
  INSTANCE_LOGO_MAX_BYTES,
  instanceLogoType,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { recordAuthEvent } from "./auth/auth-events.js";
import { publicErrorBody } from "./http.js";

/** The address pages load the logo from: it changes when the image does. */
export const INSTANCE_LOGO_PATH = "/api/instance/logo";

/** The logo's version, or null when the instance has none. */
export async function readLogoVersion(db: Database): Promise<string | null> {
  const row = await db
    .selectFrom("instanceLogo")
    .select("version")
    .executeTakeFirst();
  return row?.version ?? null;
}

/**
 * Keeps the image an administrator sent, base64, and returns its version.
 * Only what the bytes prove to be a PNG, JPEG or WebP image is kept: what
 * the upload calls itself is never read.
 */
export async function saveLogo(
  db: Database,
  actorId: string,
  data: string,
  ip?: string,
): Promise<string> {
  const bytes = Buffer.from(data, "base64");
  const contentType = instanceLogoType(bytes);
  if (
    !contentType ||
    bytes.length < 1 ||
    bytes.length > INSTANCE_LOGO_MAX_BYTES
  ) {
    throw new AppError("invalid_logo");
  }
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("instanceLogo")
      .values({ contentType, bytes, version })
      .onConflict((conflict) =>
        conflict
          .column("id")
          .doUpdateSet({ contentType, bytes, version, updatedAt: new Date() }),
      )
      .execute();
    await recordAuthEvent(trx, {
      action: "settings_changed",
      actorId,
      method: "admin",
      detail: "logo",
      ip,
    });
  });
  return version;
}

/** Back to the product's mark. Says whether there was a logo to remove. */
export async function removeLogo(
  db: Database,
  actorId: string,
  ip?: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom("instanceLogo")
      .returning("version")
      .executeTakeFirst();
    if (!removed) return false;
    await recordAuthEvent(trx, {
      action: "settings_changed",
      actorId,
      method: "admin",
      detail: "logo",
      ip,
    });
    return true;
  });
}

/**
 * Serves the image to anyone. Asked for by its version, it never changes:
 * a browser keeps it a year. Asked for without, or by an older version, it
 * is checked again each time.
 */
export function registerLogoRoute(
  app: FastifyInstance,
  deps: { db: Database },
): void {
  app.get<{ Querystring: { v?: string } }>(
    INSTANCE_LOGO_PATH,
    async (request, reply) => {
      const logo = await deps.db
        .selectFrom("instanceLogo")
        .select(["contentType", "bytes", "version"])
        .executeTakeFirst();
      if (!logo) return reply.code(404).send(publicErrorBody(404));
      const etag = `"${logo.version}"`;
      reply
        .header("ETag", etag)
        .header(
          "Cache-Control",
          request.query.v === logo.version
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }
      return reply.header("Content-Type", logo.contentType).send(logo.bytes);
    },
  );
}
