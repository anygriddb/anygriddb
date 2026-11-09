# 0010 — Files on local disk by default, any S3 as an option

- Status: Accepted
- Date: 2026-11-07

## Context

Target operators deploy on premises or on a laptop, with no cloud
connection. They must still be able to move to a VPS with cloud object
storage later. Today every attachment requires S3 (`apps/api/src/storage.ts`),
and the compose file ships RustFS.

The code uses three S3 operations: put, get, and delete. It uses no
presigned URLs: downloads go through the API, which checks the reader's
rights.

## Decision

- **One storage interface, two drivers.**
  - **Disk** (the default) writes atomically, through a temporary file and a
    rename, under one mounted volume.
  - **S3** works with any compatible service: AWS, Scaleway, OVH, Ceph,
    Garage, SeaweedFS, RustFS.
- **`anygriddb storage migrate --from fs --to s3`** (and back) moves the
  files. It keeps the promise of moving to the cloud later.
- **A background job removes files** that no row references any more.
- **Backups** are `pg_dump` plus a copy of one folder (restic, borg, rsync).
- **RustFS stays** as the S3 server the CI tests the S3 driver against, and
  as an optional compose profile (`--profile s3`). It is never the default
  and never required. Use a version after the fix for CVE-2025-68926.

## When a local S3 server is worth it

- Several API machines must share the same files.
- Large volumes sit on a separate NAS.
- The company already runs its own S3: plug it in, do not ship one.

## Rejected

- **A required S3 server.** One more service, more ports, more credentials,
  and more vulnerabilities to follow, for operators who need none of them.
- **MinIO.** Its community edition went into maintenance mode in December
  2025 and was archived in 2026. It is excluded because it is abandoned, not
  because of its license: AGPL-3.0 is an OSI license.
