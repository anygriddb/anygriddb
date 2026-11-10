# 0048 — Versions and releases: a tag, a labelled image, a version the admin sees

- Status: Accepted
- Date: 2026-11-10

## Context

Every package said `0.0.0`, no commit was tagged, and the image was
`anygriddb:local`, built from whatever checkout the operator had. Nothing
told which code a running instance served: an instance could run an image
older than `main` without anyone knowing. Traces even reported the
version as `dev` in production, `npm_package_version` being unset under
`node dist/index.js`. The update procedure pulled `main`.

## Decision

- **One version, the product's:** `version` in the root `package.json`,
  in SemVer. The workspace packages are internal and stay `0.0.0`.
  `scripts/check-conventions.mjs` refuses a root version that is not
  `MAJOR.MINOR.PATCH`.
- **`0.x` until the public API and the schema are stable**: no
  compatibility promise yet, but every release is tagged.
- **A release is a tag.** The commit `chore(release): vX.Y.Z` sets the
  version; the annotated tag `vX.Y.Z` marks it. `main` is development,
  never what an operator installs.
- **The build records what it is.** `apps/api/build.mjs` puts the
  version, the commit (`ANYGRIDDB_COMMIT`, else the checkout's), and the
  build time in the bundle; a version given in `ANYGRIDDB_VERSION` that is
  not `package.json`'s stops the build. The image carries the
  `org.opencontainers.image.*` labels: title, description, licenses,
  source, url, documentation, version, revision, created.
  `scripts/build-image.sh` fills them from the checkout and warns, without
  stopping, when the checkout is not exactly a release tag.
- **The version is shown to those who run the instance:** the Health
  tab of Administration, the support bundle, `anygriddb version`, the
  first log line, the `anygriddb_build_info` metric (behind the metrics
  token), and the traces' `service.version`.
- **`/health` stays `{ "ok": true }`.** It answers without a session;
  telling anyone the exact version would tell an attacker which known
  flaw to try.

## Rejected

- **The version from the Git tag alone** (`git describe`). An image built
  from a downloaded archive, or in a build context without `.git`, would
  not know its version. `package.json` travels with the sources.
- **Aligning every workspace package's version.** They are never
  published; seven files to bump per release would only add mistakes.
- **A changelog generated from the commits.** Operators need what changed
  for them (added, changed, fixed, breaking), written for them.

## Consequences

- An image built with `docker compose up --build` knows its version and
  build time, but not its commit unless `ANYGRIDDB_COMMIT` is set:
  Health says "commit not recorded". `scripts/build-image.sh` sets it.
- Between two releases, `main` reports the last release's version with
  another commit: the commit tells them apart.
- Still to come: images published to a registry, tagged by version and
  pinned by digest in Compose; release notes for operators; an opt-in
  check for a newer release (no call home by default).
