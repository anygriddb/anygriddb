# 0019 — One image, offline install, no telemetry

- Status: Accepted
- Date: 2026-11-07

## Decision

- **One image**, `anygriddb`, holds the API, the built web app (ADR 0011),
  and the workers (ADR 0008).
- **The default compose file runs two services**: `anygriddb` and
  `postgres` (18), plus a volume for files (ADR 0010). Optional profiles
  add S3 (RustFS).
- **Offline install:** images exported with `docker save` and loaded on a
  machine with no internet access. At runtime the app calls no outside
  service. The one exception is a clickable OpenStreetMap link in the map
  view; map tiles, when they come, will be self-hostable.
- **Placement:** AnyGridDB runs close to the databases it reads (ADR 0006),
  in the same network or region.
- Helm and other installers stay outside this repository.
