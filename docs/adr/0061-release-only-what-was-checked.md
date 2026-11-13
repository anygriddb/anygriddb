# 0061 — A release publishes only what was checked, for amd64 and arm64

- Status: Accepted
- Date: 2026-11-13

## Context

ADR 0048 made a release a tag that publishes an image. The Release
workflow built the image and pushed it: it did not ask whether `main`'s
CI had passed on the tagged commit, never started the image, scanned only
`main`'s build of the week, and built for `linux/amd64` alone, so an
operator on an ARM server or an ARM laptop could not run it natively.
Pull requests never built the image either: a Dockerfile or a start-up
that broke showed only after the merge.

## Decision

- **A tag publishes nothing until `CI` passed on its commit on `main`.**
  The workflow waits for that run, and stops when it did not succeed.
  `main`'s runs are no longer cancelled by the next push, so every commit
  of `main` has one to show.
- **Each architecture, natively:** `linux/amd64` and `linux/arm64`, each on
  a runner of its own, without emulation.
- **Started and scanned before it is pushed:** each image is started the
  way an operator starts it (`docker/compose.yml`: certificates,
  PostgreSQL over verified TLS, migrations; `scripts/smoke-image.sh`),
  must answer `/health`, `/ready` and report its version, and passes the
  same Trivy scan as `main` (system packages, high and critical, with a
  fix). Then it is pushed by digest, and one name joins both digests.
- **The image tested is the image pushed:** the push rebuilds from the
  same cache at the commit's time (`SOURCE_DATE_EPOCH`), so the bytes do
  not change between the two.
- **Its provenance attested:** the published image carries an
  attestation, signed by GitHub for that run alone, of the workflow,
  commit, and run that built it; operators check it with
  `gh attestation verify` before installing. The push itself uses the
  run's own token, which expires with it: no lasting secret.
- **What each image holds, listed:** the release carries one SPDX file
  per architecture (`anygriddb-amd64.spdx.json`,
  `anygriddb-arm64.spdx.json`), written from the image that was started
  and scanned: its system and Node.js packages. The libraries compiled
  into the browser's bundle are not in it.
- **A rehearsal:** run by hand on a commit of `main`, the workflow does
  everything but log in and publish.
- **Every pull request builds the image and starts it** (CI's `image`
  job).
- **A pull request runs every test when it changes a file outside the
  packages** (`scripts/ci-turbo.sh`). Otherwise it runs only the packages
  it changes, which Turborepo works out from the packages' own files: a
  change to the workflows, `scripts/`, or `docker/` belongs to none of
  them, and ran no test at all.

## Consequences

- A release takes longer: the wait for `main`'s CI, then two builds in
  parallel, each started and scanned.
- A pull request that changes the workflows, `scripts/`, or `docker/`
  takes as long as `main`'s CI.
- A scan that finds a fixed high or critical flaw in the base image stops
  the release until the base pin moves (Dependabot moves it weekly).
- `image-pin.env` names the multi-architecture index: the same digest
  installs on both, and Docker pulls the host's.
- `image` is a check of every pull request; making it required is a
  setting of the repository's ruleset.
