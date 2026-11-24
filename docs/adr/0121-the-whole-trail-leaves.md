# 0121 — The whole trail leaves, and an event's place in it is the database's

- Status: Accepted (amends 0120)
- Date: 2026-11-24

## Context

The copy of ADR 0120 began with the newest event when an administrator
turned it on. What was written before, often what matters most to an audit,
stayed where whoever holds the owner's credentials could rewrite it unseen.
Events written before 0.6.1 have no write order at all (migration 0128), and
the copy read the trail only by that order.

The application's role also gave an event the write order and the
transaction its insert named. An event inserted with an order below what had
already been sent, or with none, would never have left: a stolen application
account could add an event in someone's name that no collector would ever
see.

## Decision

- **The whole trail goes, oldest first.** Turned on, the copy starts before
  the first event. The events without a write order go first, by their date
  then their id, then the others in the order they were written. A copy
  turned on with 0.7.1 sends the whole trail again, in the same chain: an
  event may reach a collector twice; none is missing.
- **`anygriddb trail verify` checks both,** and names an event without a
  write order, between two sent, that no batch carried.
- **An event's place is the database's to give.** A trigger takes the write
  order from the sequence and the transaction from the session for every
  event a role that does not own the trail inserts, whatever the insert
  said. The owner keeps what it writes, so that a restore brings each
  event's own. It costs about three microseconds an event.
- **The early events are read by an index of their own,** built like the
  write order's: by the migration on a short trail, beside the writes after
  the start on a long one.

## What this does not do

The copy stays off by default. A collector priced by volume would otherwise
receive the whole trail on the day of an upgrade, unasked.

## Rejected

- **Giving the early events a write order.** It would rewrite the trail,
  which nothing but the owner's functions may do, for every instance older
  than 0.6.1.
- **Refusing an insert that names its order.** Taking the order from the
  sequence gives the same guarantee and breaks no caller.
