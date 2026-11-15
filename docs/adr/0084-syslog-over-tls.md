# 0084 — Sign-in events to a syslog collector, over TLS

- Status: Accepted (extends 0056)
- Date: 2026-11-15
- Relates to: 0056 (the HTTPS collector), 0050 and 0083 (what the
  environment holds), 0006 (which hosts the instance connects to)

## Context

Selected events of the sign-in trail go to a collector over HTTPS
(ADR 0056). Some collectors take syslog only. A first attempt sent each
event in clear text, over UDP or TCP, from the request that made it, with
no second try and no check of the host it reached: an event was lost
whenever the collector was away, and read by whoever sat on the path.

## Decision

- **The same events, the same content.** One list of actions and one
  shape for both collectors: ids and codes, the client address, never a
  person's email or a secret.
- **From the queue.** Recording an event adds a job in the same
  transaction: an event rolled back sends nothing, and one that is kept
  is tried five times, further apart each time, when the collector is
  away. The trail never waits for the collector.
- **TLS only (RFC 5425), verified.** One RFC 5424 line per event, counted
  in octets (RFC 6587), written once the collector's certificate is
  verified for its name against the system's authorities and, when given,
  the operator's own. TLS 1.2 at least. The whole exchange has five
  seconds.
- **Named where the instance is installed**: `SYSLOG_HOST`, `SYSLOG_PORT`
  (6514 by default), `SYSLOG_CA_FILE`. Administration shows where events
  go and sends one to try it; it sets nothing. A value that names no
  collector stops the start, saying which variable.
- **The command line ships too.** What `install-token` and
  `admin recover` write to the trail goes to the same collector.

## Rejected

- **A collector saved in Administration.** A syslog collector sits on
  the operator's network, where the HTTPS collector must be a public
  address. A host and a port typed in a page would let an
  administrator's session, or whoever took it, make the instance open
  connections inside that network. Which of its hosts the instance
  reaches is said where it is installed, as for the sources (ADR 0006).
- **Clear text, or TLS without verification.** The events say who failed
  to sign in, from where, and which setting changed.
- **Sending from the request.** A slow collector would slow every
  sign-in, and an absent one would lose the event.
- **A syslog agent in the image.** One more process to run and to patch,
  for what one connection does.

## Consequences

- An instance that names no collector queues nothing and connects
  nowhere.
- The support bundle says whether a collector is named, never which.
- Lines are the events' own: the application's logs still go to the
  container's output, for the collector of the host.
