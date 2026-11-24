# 0120 — The change trail leaves a copy out of the database's reach

- Status: Accepted
- Date: 2026-11-24

## Context

Since ADR 0119 the application's own account cannot rewrite the change
trail. The role that owns the tables still can: it can disable the trail's
triggers, change an event, delete one or give it another author, and nothing
in the database would show it. Whoever holds the owner's credentials, or the
database server itself, holds the whole record.

The sign-in trail already leaves for a collector the operator runs, over
HTTPS or as syslog over TLS (ADRs 0056, 0084). The change trail did not:
its events carry the values written, and those are the data an instance
keeps for its users, health or banking data among them, which cannot go to
a collector.

## Decision

- **Each event leaves as a fingerprint**, once an administrator turns it on
  (`trailToCollector`, Administration > Security > Change trail): its id,
  its write order, its time, its action, its author and the person acted
  as, and an HMAC-SHA-256 of everything the event holds, under a key of the
  instance (the use `trail` of `AUTH_ENCRYPTION_KEY`, ADR 0066). No value,
  table or field name leaves. The key keeps a collector from testing a
  guess against a fingerprint.
- **In batches, in the order the events were written,** to every collector
  the instance names. A batch is numbered and carries the digest of the
  batch before, so that a batch lost or changed on the way shows at the
  collector. A collector that refuses stops the sending, and the same batch
  goes again a minute later: a collector may get a batch twice, with the
  same number and content.
- **Nothing is skipped.** A write order is taken as an event is written, so
  a transaction still open can hold an order below one already committed. A
  batch only goes up to an order noted together with the snapshot's horizon,
  once every transaction open at that moment has ended. A restored database
  is recognised by a horizon past its own, and notes it again.
- **`anygriddb trail verify <file>`** compares what a collector kept with
  the database, and exits 1 when it finds: a batch changed, missing, out of
  its chain, or two batches of one number (a restore, or a forgery); an
  event changed, deleted though no purge could reach it, or given another
  author; an event in the database between two sent, never sent. An event
  older than the latest purge's bound, and older than the shortest retention
  an instance can choose, counts as purged. An author replaced by the
  erasure's placeholder counts as erased once the account no longer exists.
- **From when it is turned on.** The events before were never sent. Turned
  off, nothing is sent; turned on again, what was written meanwhile goes.
- **Read by an index on the write order.** A short trail gets it from the
  migration. A long one gets it after the start, beside the writes (`anygriddb
database indexes`, or the start itself when the application owns the
  tables): built inside the migration, it would hold every write until it
  ends. Until then nothing is sent, and Administration says why.

## What this does not do

It detects and does not prevent: the owner's account can still rewrite the
trail, and the copy shows it. Whoever holds the key and the application can
send false fingerprints from then on, or stop the sending: the collector
sees batches stop, and the setting turned off goes to it on the sign-in
trail. What left before cannot be changed.

## Rejected

- **Sending the events themselves.** The values would leave the instance.
- **A chain kept in the database.** Rejected alone in ADR 0119: whoever
  rewrites the trail rewrites the chain with it.
- **One digest over a span of events.** A purge and an erasure change the
  trail as they should, and would break every span they touch; a
  fingerprint per event keeps each one verifiable on its own.
