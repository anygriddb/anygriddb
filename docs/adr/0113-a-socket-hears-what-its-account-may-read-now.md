# 0113 — A socket hears what its account may read now

- Status: Accepted
- Date: 2026-11-22

## Context

A socket's channels were allowed once, when it subscribed. A role taken away
afterwards left it following them, on every process but sometimes the one that
made the change. A message also named the row and the fields that changed, for
a reader whose row or field rules might hide them. And a client that stopped
reading made the server hold what it could not send.

## Decision

- **Rights are asked again.** Each process asks, in one grouped question, at
  every heartbeat, and at once when any process says rights changed. A channel
  no longer allowed is left, and the page reads again, which says so.
- **A reader under a row or field rule hears that a table moved,** never which
  row or field, and reads the table again through its own rules.
- **A socket costs a bounded amount.** It is closed past 1 MiB of unread
  messages, an account holds 64 sockets per process, what one socket may send
  is limited, and a pong counts only when it answers the ping under way.
  Refusals are counted in `anygriddb_websocket_refused_total`.

## Rejected

- **Closing an account's sockets on each path that removes a right.** A path
  added later, an expiry, or another process would be missed.
- **Filtering each message through the reader's rules.** One read per message
  and per reader, for a detail a page gets by reading again.

## Consequences

A right changed by something no call announces, such as a table put in the
trash, takes effect at the next heartbeat, within 25 seconds. A page under a
row or field rule reloads its view when its table changes, rather than only the
rows that moved. A client past a limit reconnects and reads again.
