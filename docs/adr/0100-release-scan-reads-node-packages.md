# 0100 — A release is refused on a fixed advisory in a Node.js package too

- Status: Accepted
- Date: 2026-11-16
- Amends: 0061

## Context

ADR 0061 has each image started and scanned before it is pushed, and
`main` scanned on every push and every week. Both scans read the
image's system packages only. The Node.js packages the application runs
with were left to two other checks: the dependency review, which reads
what a pull request adds, and the alerts on `main`.

Neither stops a release. An advisory published after its dependency was
merged is on no pull request, and an alert is a notice, not a gate: a
tag pushed that day published an image with a known flaw that had a fix.

## Decision

- **The scan reads both**: the system's packages and the Node.js
  packages installed in the image, high and critical, with a fix. On
  `main` and weekly, where a finding shows in the Security tab; and on a
  release, where it stops the publication.
- **What is scanned is the image**, not the lockfile: what an operator's
  own scanner will read, development dependencies left out.

## Consequences

- A release can be stopped by a dependency. The way through is the one
  an operator would ask for anyway: move the dependency to the version
  that fixes it, by a pull request, then tag again.
- A flaw with no fix does not stop a release: there is nothing to move
  to.

## Rejected

- **Critical only for Node.js packages.** A high advisory with a fix is
  one an operator's scanner reports as ours; the two kinds of packages
  are held to the same line.
- **Failing pull requests on it.** An advisory published overnight would
  fail every open pull request, whatever it changes; the weekly scan and
  the one on `main` say it once.
