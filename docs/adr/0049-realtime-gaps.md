# 0049 — Realtime gaps: every page re-reads what it may have missed

- Status: Accepted (completes 0009)
- Date: 2026-11-10

## Context

Realtime messages carry ids, never values: a tab re-reads what changed
with its own rights (ADR 0009). They are hints, and the app has no other
way to stay fresh: queries are not read again on focus. A lost hint leaves
a page out of date until the person acts on it, with no sign, and a cell
written from a stale page overwrites a newer value (the last write wins).

The server already covered one gap: when its `LISTEN` connection comes
back, it sends `stale` on every channel. Only the grid acted on it. The
others were not covered at all:

- the browser's link closing (network, restart, upgrade, proxy, a
  reauthorization): the tab subscribed again and read nothing;
- a link dead but still open (a laptop asleep, a dropped NAT entry, a
  proxy cutting idle connections): nothing noticed it;
- a link that never opens (a proxy that does not forward the WebSocket
  upgrade): the app looked fine and never heard anything.

A "Live / Offline" label in the sidebar was the only sign of the last
three. It said the normal state all the time, and nobody read it.

## Decision

- **After any possible gap, every subscriber re-reads what it shows.**
  `useChannel` takes a `resync` handler next to `message`, and the type
  requires it: rows reload their loaded pages, the sidebar and the table
  their catalog, the bell its notifications, jobs their state, presence
  says where its person is.
- **Re-read once live again, not before**: after a lost link, at the
  server's `subscribed` for each channel. A read made before that could
  miss a change made in between. The server's `stale` calls `resync` too.
- **A heartbeat makes "open" mean something.** Every 25 s the server pings
  each socket and cuts one that did not answer the last ping, which ends
  its presence. It also sends `beat`, which the page sees (a browser hides
  pings). A page that hears nothing for 65 s drops the link and opens
  another. The traffic also keeps proxies from closing idle links.
- **Reconnecting** backs off from 0.5 s to 30 s, with ±20 % jitter so
  clients do not all come back at once after a restart. It is immediate
  when the network comes back or the tab is shown. A close for an ended
  session (4401) reads the session again, which leads to sign-in.
- **Nothing on screen while it works.** After 10 s without a link, a
  banner says that others' changes will show once it is back, with a
  button to reconnect now. Editing goes on over HTTP. When the link
  returns, the page has re-read itself and the banner goes away.

## Rejected

- **A status label kept on screen.** It reports the normal state, and
  telling people does not fix a stale page; re-reading does.
- **Numbered messages replayed from a log.** It would make NOTIFY durable,
  and that is not what it is for (ADR 0009). Re-reading what is shown is
  cheaper than a replay, and it is correct under the reader's rights.
- **Re-reading on every focus of the tab.** It would cost a read on each
  focus and still miss gaps while the tab stays in front.

## Consequences

- A page whose first link opens at once reads nothing twice. A change
  made in the round trip between a page's first read and its first
  subscription is not re-read; the window is a few milliseconds.
- Behind a reverse proxy, `/ws` must pass the WebSocket upgrade, or the
  banner says the connection is lost (docs/operations.md).
- Conflicting writes (the last one wins) are a separate question: rows
  have no version yet.
