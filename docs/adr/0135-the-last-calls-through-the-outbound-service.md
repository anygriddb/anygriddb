# 0135 — The last calls out go through the outbound service

- Status: Accepted
- Date: 2026-11-26
- Amends: 0125 (one outbound service)
- Relates to: 0048 (the release check), 0053 (proving an issuer), 0088
  (stores read through their REST API), 0105 (syslog from Administration)

## Context

ADR 0125 made the outbound service the way a call leaves over HTTPS, but
five paths still opened their own: the release check and the import from
another product called `fetch` with no cap on the answer; the proof of an
OpenID issuer, the sign-in's discovery, its key set and its code's
exchange went through the libraries' own clients, with no check of the
address they reached; the stores read through a REST API and the syslog
collector opened Node's sockets beside the service. Nothing held the next
one to the rule.

## Decision

- **Every call out is one `requestOutbound`:** a library that takes a
  `fetch` (the OpenID client, the key set) is given `outboundFetch`, the
  service as a `fetch`; the release check and the import call it too, each
  with its answer's ceiling.
- **An identity provider may be private:** an administrator or the
  operator named it, and an organisation's provider often sits on its own
  network. Its calls go through the service with private addresses allowed;
  a reserved one (the machine itself, a cloud's metadata) is refused, and
  each socket connects to the address that was checked.
- **Where a private network is allowed, so are its own names** (`.internal`,
  `.local`): they were refused before they were resolved, which would have
  shut out a provider named in its organisation's zone (found by signing in
  against a real provider). Their addresses are checked as any other; the
  machine's names and a cloud's metadata stay refused. A notification
  channel's administrator who allowed private networks gets the same.
- **The release check and the import from another product reach the
  public internet only.**
- **The two clients that keep a socket open live in the service:** the
  stores' JSON client (`outbound/store-http.ts`), whose rule stays the
  operator's list of source hosts (a source is on the operator's own
  network, the loopback included), and the TLS frame to a syslog collector
  (`outbound/tls-frame.ts`).
- **A test reads the tree** (`outbound/only-outbound.test.ts`): no module
  outside `outbound/` imports Node's clients or calls `fetch`, but the
  server's own listening socket, the container's check of its process on
  the loopback, and the connection an upload holds open. A library that
  opens its own (PostgreSQL's, the object store's, mail's, a client
  database's driver, the trace exporter's) imports none of them here.

## Consequences

- An identity provider on an address reserved for the machine or a
  cloud's metadata no longer answers: such an address is never one's
  provider.
- An answer larger than its ceiling is refused: a discovery document or a
  key set of more than a mebibyte, a release's of more than one.
- The next call out is held by the test, not by review.
