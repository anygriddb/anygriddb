# 0105 — The syslog collector is set in Administration

- Status: Accepted
- Date: 2026-11-17
- Amends: 0084
- Relates to: 0056 (the HTTPS collector), 0083 (what the environment
  sets), 0092 (notification channels, and private networks)

## Context

ADR 0084 sent the sign-in trail's events to a syslog collector named in
the instance's environment, and nowhere else: a host and a port typed in
a page, it said, would let an administrator's session make the instance
open connections inside the operator's network.

A day later ADR 0092 gave notification channels to Administration, with
their addresses, and settled that very question another way: an address
is checked before and at the connection, and one of a private network
is refused unless an administrator allows private networks. Two records
answered one question twice. The second is the rule everywhere else an
administrator names an address, and an instance is meant to be set up
from Administration, with an environment that holds only what a first
start needs: a collector was the one integration that asked for a file
edited and a restart.

## Decision

- **An administrator sets the collector in Administration**, under
  Connections: a host, a port (6514 unless another is given), and the
  certificate of an authority when the system's do not know the
  collector's. It asks for the proof, as every change there does
  (ADR 0073), and is on the sign-in trail.
- **Saved once it took an event.** The collector is sent a test event
  with the settings typed, over TLS with its certificate verified; a
  collector that does not take it is not saved.
- **Held to what a notification channel is** (ADR 0092). The machine
  itself, a link-local address, and a cloud's metadata address are
  never a collector. An address of a private network is one only where
  an administrator allowed private networks. The name is resolved, the
  addresses checked, and the connection made to what was checked, at
  the save and at every event.
- **The environment's collector wins when it names one** (ADR 0083).
  Administration then shows it and cannot change it; what was saved
  there stays, unused, and can be removed. An operator's collector is
  reached as named: where the instance is installed, the operator's word
  is the rule.
- **Nothing else of ADR 0084 changes**: the same events and the same
  line, from the queue, tried again when the collector is away, TLS
  only, never from the request that made the event.

## Consequences

- A collector no longer needs a restart, nor a hand on the host.
- One table, `instance_syslog`. The authority's certificate is kept as
  text: it is no secret. Administration says that one was given, and
  does not show it.
- An event queued for a collector that has since been removed is
  dropped, as one the environment no longer names was.
- The API of Administration (ADR 0086) does not set the collector: it
  is not among the settings a token may change.

## Rejected

- **The environment alone (ADR 0084).** It kept a collector from an
  administrator who may already point a notification channel, a
  webhook's collector, and the mail relay somewhere.
- **A collector reached without the check when saved in
  Administration.** The page would then open what ADR 0092 closed.
- **Private networks allowed for a collector by a setting of its own.**
  One setting says whether this instance's administrators may name
  private addresses; a second would be the first one again.
