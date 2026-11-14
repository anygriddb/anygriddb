/**
 * Which AnyGridDB this is (ADR 0048): the product's version, from the root
 * package.json, the commit it was built from, and when. The production
 * build sets __ANYGRID_BUILD__; from sources (tsx, Vitest) the constant
 * does not exist, so the version is read from the root package.json and
 * the rest stays unknown.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const buildInfoSchema = z.strictObject({
  version: z.string().regex(SEMVER),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  builtAt: z.iso.datetime().nullable(),
});

type BuildInfo = z.infer<typeof buildInfoSchema>;

declare const __ANYGRID_BUILD__: unknown;

/** A build's facts, or a thrown error naming the one that is wrong. */
export function parseBuild(value: unknown): BuildInfo {
  return buildInfoSchema.parse(value);
}

/** From sources: the root package.json's version, nothing else known. */
export function sourceBuild(manifest: unknown): BuildInfo {
  const { version } = z.looseObject({ version: z.unknown() }).parse(manifest);
  return parseBuild({ version, commit: null, builtAt: null });
}

function currentBuild(): BuildInfo {
  if (typeof __ANYGRID_BUILD__ !== "undefined") {
    return parseBuild(__ANYGRID_BUILD__);
  }
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  return sourceBuild(manifest);
}

export const BUILD: BuildInfo = currentBuild();

/** One line for people: `AnyGridDB 0.1.0 (commit 0123456789ab, built …)`. */
export function describeBuild(build: BuildInfo): string {
  if (build.builtAt === null) {
    return `AnyGridDB ${build.version} (from sources)`;
  }
  const commit = build.commit
    ? `commit ${build.commit.slice(0, 12)}`
    : "commit not recorded";
  return `AnyGridDB ${build.version} (${commit}, built ${build.builtAt})`;
}
