# 0108 — A base's snapshot carries its dashboards

- Status: Accepted
- Date: 2026-11-20
- Amends: 0039 (what a snapshot holds), 0077 (what a restore point keeps)
- Relates to: 0076 (snapshot rows as lines), 0035 (dashboard charts)

## Context

A base's snapshot held its tables, their views, rows, files, members, and
folders, and nothing of its dashboards. The same snapshot is what a base
is exported as, what a copy of a base is made of, and what a restore
point keeps (ADR 0077). So a base copied, restored, or imported from its
file came back without a single dashboard, and nothing said so: the
restore point's own screen called it "the whole base".

A dashboard is settings and nothing else: a name, and widgets that each
read a table, sometimes through one of its views. It holds no row and
calls nothing outside the instance. The only thing that ties it to its
base is two ids, the table's and the view's.

## Decision

- **A snapshot lists the base's dashboards**, in their order, under
  `dashboards`: each with its name, its description, and its widgets
  with their title, kind, place, and settings.
- **A widget names what it reads as the snapshot knows it**: its table by
  the table's key, its view by the view's rank among that table's views.
  Its settings are written without the two ids; a file that carries
  either is refused, as is a widget whose table or view the snapshot does
  not list, or whose settings its kind does not read with. On import the
  dashboards are made last, once the tables and their views exist.
- **A widget the snapshot cannot hold is left out and counted**
  (`left`): one that reads a table that lives in a client's database,
  which a snapshot does not take, or a view only its author has. Kept
  without its view, under the same title, it would show another figure.
  The import's report says how many were left, next to the files and the
  people it could not bring.
- **The format's version stays 3**, and `dashboards` is written only for
  a base that has some, as `folders` is: the snapshot of a base without
  dashboards is the one it was, and a file written before reads as it
  did.
- **What acts outside the base stays behind, on purpose**: automations,
  webhooks, and public links. A copy that came with them would send each
  mail and each call a second time, and a link would open two bases.
  Comments and the history of changes stay with the base they were
  written in. The screen that exports a base says what stays.

## Consequences

- A base that has dashboards gives a file an earlier version refuses:
  its reader knows no `dashboards` key. A base moves forward, to the
  same version or a later one.
- A copy, a restored base, and an imported base show the figures of
  their own rows: nothing in them reads the base they came from.
- The members a restore gives their access back find the dashboards
  too: a dashboard is read under each reader's own rights, as before.

## Rejected

- **Carrying automations turned off.** Their steps name people, hosts,
  and secrets that are sealed for one instance; a copy would hold
  automations that look whole and are not. It can be decided on its own.
- **Keeping a widget without the view it lost.** A total over a view of
  some rows would become a total over all of them, under the same name.
- **A new version of the format.** An earlier reader would refuse every
  file, the ones without a dashboard among them.
