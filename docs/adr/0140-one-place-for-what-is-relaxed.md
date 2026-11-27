# 0140 — One place for every requirement an administrator relaxes

- Status: Accepted
- Date: 2026-11-27
- Amends: [0139](0139-plaintext-source-opt-in.md), [0125](0125-one-outbound-service.md)
- Leaves as they are: [0029](0029-https-only.md), [0030](0030-every-connection-encrypted.md)

## Context

Two requirements could be relaxed from the screens, each its own way. A
source could connect without TLS (ADR 0139): a column of `sources`, a
confirmation in the source's dialog, a badge, and the catalog's trail. The
channels and collectors of Administration could call a private address: a
setting, `notifyAllowPrivate`, a checkbox without a confirmation, and a
line "Setting changed" in the sign-in trail that did not say which way it
went. Nothing listed what an instance had relaxed, so an administrator
taking over one had to open every source and every page to find out, and
a third relaxation would have been a third way.

What may be relaxed at all was weighed requirement by requirement. One may
be relaxed only where the administrator who decides is the one who bears
the risk, and going back to strict loses no data. Encryption of the
instance's own database, HTTPS for the people who sign in, the allowed
hosts an operator sets, a source's account that is not an administrator of
its database, a client table's schema left alone, the password floor, the
encryption of mail and of the collectors, and the address checks of every
other call out stay as they are: their risk falls on others than the one
who would relax them, or on data already sent.

## Decision

- **One catalogue, in the core** (`RELAXATIONS`): each requirement that
  may be relaxed, with what it is relaxed for (the instance, or one source)
  and the version of the consequence an administrator confirms. Two now:
  `source.plaintext` (one source connects without TLS) and
  `notify.private_networks` (Administration's channels, heartbeats and
  collectors may call a private address; loopback and cloud metadata stay
  refused). An address of a public link's embed on this machine's loopback
  is no relaxation: it is a fixed rule, as for OAuth's redirect addresses.
- **One table** (`relaxations`, migration 0159): a row says that a
  requirement is relaxed, for what, by whom, when, and which consequence
  was confirmed. No row is the strict default; deleting the row goes back
  to it. The column `sources.allow_plaintext` and the setting
  `notifyAllowPrivate` are moved into it and removed.
- **One way to relax, by an administrator of the instance**
  (`settings.manage`), after a confirmation that says the consequence. A
  source manager may change a source, and take its relaxation away, but
  not relax it. Going back to strict is offered where the requirement is
  used and on one page, Administration › Security › Relaxed requirements,
  which lists every row.
- **One trail.** Relaxing and going back write `relaxation_enabled` and
  `relaxation_disabled` to the sign-in trail, with the requirement's key,
  and reach the collectors as every event of that trail does.
- **Marked where it applies:** a source without TLS keeps its badge and
  the sources page its warning; the notifications page says when private
  networks are allowed.

## Consequences

- An instance's relaxations are read in one place, and each one's history
  in the sign-in trail.
- A new requirement that may be relaxed is a key of the catalogue, a value
  of the table's check, and its gate reading `relaxationAllows`: never a
  setting or a column of its own.
- `admin.updateSettings` no longer takes `notifyAllowPrivate`: the
  screens relax private networks through the catalogue. (The
  administration API never took it.)
- A source manager who could untick and tick a source's clear connection
  needs an administrator to tick it again.
