/**
 * Opt-in check for a newer published release (ADR 0048). The URL is fixed
 * to this project's GitHub Releases feed: no operator-supplied host, so
 * the call cannot be turned into an SSRF probe. Off by default.
 */
import { AppError } from "@anygriddb/core";
import { z } from "zod";

/** Hard-coded feed; never take a host from settings or the request. */
export const RELEASE_FEED_URL =
  "https://api.github.com/repos/anygriddb/anygriddb/releases/latest";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A feed that does not answer in this time counts as unreachable. */
const CHECK_TIMEOUT_MS = 10_000;

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  prerelease: z.boolean(),
  draft: z.boolean(),
});

export type ReleaseCheckResult = {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
};

/** Compare two `MAJOR.MINOR.PATCH` versions: -1 / 0 / 1. */
export function compareSemVer(left: string, right: string): -1 | 0 | 1 {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) {
    throw new AppError("invalid_input", "version");
  }
  for (let i = 1; i <= 3; i += 1) {
    const lv = Number(a[i]);
    const rv = Number(b[i]);
    if (lv < rv) return -1;
    if (lv > rv) return 1;
  }
  return 0;
}

/**
 * Whether `latest` is newer than the version running. A pre-release build
 * (`0.2.0-rc.1`) is never told about releases.
 */
export function isNewer(running: string, latest: string): boolean {
  return SEMVER.test(running) && compareSemVer(running, latest) < 0;
}

function tagVersion(tag: string): string | null {
  const trimmed = tag.trim();
  const body = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  return SEMVER.test(body) ? body : null;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Reads the latest non-draft GitHub Release and compares it to `current`.
 * Callers must have checked that the administrator opted in.
 */
export async function checkLatestRelease(
  current: string,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<ReleaseCheckResult> {
  if (!SEMVER.test(current)) {
    throw new AppError("invalid_input", "version");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(RELEASE_FEED_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "AnyGridDB-release-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: options.signal ?? AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("release_check_failed");
  }
  if (!response.ok) {
    throw new AppError("release_check_failed", String(response.status));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AppError("release_check_failed");
  }
  const parsed = releaseSchema.safeParse(body);
  if (!parsed.success || parsed.data.draft || parsed.data.prerelease) {
    throw new AppError("release_check_failed");
  }
  const latest = tagVersion(parsed.data.tag_name);
  if (!latest) {
    throw new AppError("release_check_failed");
  }
  return {
    current,
    latest,
    newer: compareSemVer(current, latest) < 0,
    url: parsed.data.html_url,
  };
}
