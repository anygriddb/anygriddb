# 0129 — Rows leave a base by an export, and a token by its own permission

- Status: Accepted
- Date: 2026-11-25
- Relates to: 0127 (permissions of a base), 0128 (made roles), 0043
  (API tokens), 0094 (applications), 0077 (restore points)

## Context

ADR 0128 let an administrator make a role that reads rows without
exporting them. The application kept its word on its own screens, but a
role without the export still took rows out by other ways:

- a token read every row the role read, a thousand a page, through the
  REST API, MCP and the procedures of the application, and an application
  was given the same;
- a view's public link showed its rows to whoever held it, and a base's
  its whole base, on `publish` alone;
- a webhook sent each changed row to an outside address, and an automation
  could mail, call, post to a channel or run a script with a row's values,
  or loop over a table and copy its rows elsewhere;
- a table copied with its rows landed in a table where its maker's field
  and row rules did not follow, and a base copied, or a restore point read
  back as a new base, became a base its maker owned whole.

Things made in someone's name also kept acting when that person no longer
could: a link read its creator's reading, a webhook its creator's
reading, and neither looked at whether the account was disabled.

## Decision

- **A token's way in is a permission:** `api.access` ("Reach by a token").
  A token, an application's included, reaches a base or a table only
  through a role that gives it (`tokenGiven`, applied to a token's roles
  in `scopeBindings`). A table's role that does not still stands over the
  base's there: the table stays out of the token's reach. An application
  is given only bases whose role lets a token in.
- **Every way rows leave asks `data.export`**, besides what it asked
  already: a view's public link (a form's takes answers in and asks
  publishing alone), a base's link, a webhook, an automation whose actions
  take values out of their table (`tablesTakenOut`), a table copied with
  its rows, a base copied, and a restore point read back as a new base. A
  table copied with its rows is also refused to whom a field or a row rule
  binds on it (`copy_under_rules`): the copy carries no rule.
- **What is made in someone's name acts by their roles as they are when
  it runs** (`authorBindings`): a link when it is opened, a webhook when it
  delivers, an automation at each run, a feed when it is read. It asks
  what its making asked; while that is not held, or the account is
  disabled, it does nothing, and it stays.
- **The four shipped roles hold both permissions**, so nobody who holds
  one of them loses anything. **A permission a version adds goes to no
  made role**: an administrator gives `api.access` to the made roles that
  should reach by a token.

## Consequences

- A made role without `api.access` reaches nothing by a token after the
  upgrade, its holders' existing tokens included, until an administrator
  adds it to the role.
- A made role without `data.export` can no longer make the links,
  webhooks, automations and copies listed above, and those its holders
  made stop until they hold it again. Links, webhooks and automations made
  by someone since disabled stop too.
- `docs/operations.md` lists every way out, what it asks, and what stays
  within a reader's own reach on purpose (the grid's copy, a printed row,
  the application's API console).
