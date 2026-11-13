# 0066 — Encryption keys with an identifier, one per use, and changed without loss

- Status: Accepted
- Date: 2026-11-13

## Context

One key, `AUTH_ENCRYPTION_KEY`, sealed everything the instance keeps
secret (second factors, the passwords of sources, mail, single sign-on
and the log collector, webhook secrets, the private keys of its
certificates) and signed backup codes and share-access proofs, each time
with the key itself. Nothing said which key had sealed a value, so the
key could not be changed: with another key, nothing opened (ADR 0015 left
this for later).

## Decision

- **A key has an identifier.** `AUTH_ENCRYPTION_KEY` is `id:base64`, or
  the 32 bytes alone, which is the key `0`: an instance that never named
  its key changes nothing. `AUTH_ENCRYPTION_PREVIOUS_KEYS` lists the
  earlier keys, `id:base64` separated by commas. Together they are the
  key ring; the process holds it, and nothing else does.
- **A sealed value says which key sealed it**: one byte, the length of
  the identifier, the identifier, then the AES-256-GCM bytes as before.
- **No value is sealed or signed with a master key any more.** Each use
  (second factors, sources, webhooks, mail, …) has a key of its own,
  derived from the master with HKDF-SHA-256 and the use's name. A value
  of one use does not open as another.
- **Everything sealed before still opens.** A value from before
  identifiers has no mark, and its first byte can be anything, the
  marker included. The bytes are read as carrying an identifier, then as
  an older value under each master of the ring; the authentication tag
  decides. Signatures are checked the same way: against each key of the
  ring, derived and as it was.
- **`anygriddb keys rotate` seals again** under the current key what an
  earlier one sealed, a row at a time, only where the value is still the
  one it read; `keys status` counts what each key still holds, and `keys
new` makes a key. The guide's "Changing the encryption key" is the
  procedure.

## Consequences

- An operator changes the key with no downtime and no window where a
  secret cannot be read, and knows from `status` when the earlier key
  can go.
- Backup codes are hashes: they cannot be rewritten. Those made before a
  change work while the earlier key is kept. A sign-in under way and a
  queued job's token are not rewritten: they live minutes.
- A backup holds what the key of its day sealed: restoring it needs that
  key in the ring.
- Losing every key of the ring still loses every sealed secret.

## Rejected

- **Keys kept in the database**, wrapped or not: the operator's
  environment stays the only place a master key is.
- **Telling an older value by its first byte alone.** One in 256 starts
  with the marker; it would have been read as naming a key nobody holds.
- **A column for the key's identifier** beside each sealed value: seven
  tables and the certificate files to change, for what a prefix carries.
