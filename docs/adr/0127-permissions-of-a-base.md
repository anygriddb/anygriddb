# 0127 — A base's roles are packs of permissions, one per act

- Status: Accepted; superseded in part by 0131 (a role on a table adds to its base's)
- Date: 2026-11-25
- Relates to: 0057 (who grants on a base), 0126 (parts of Administration)

## Context

The four roles of a base were a ladder of four ranks (viewer, commenter,
editor, owner) and every check asked for a rank: `read`, `comment`,
`write` or `manage`. A rank says nothing of the act it guards. `write`
stood for editing a cell, deleting rows, importing a file and publishing
a view's link; `manage` for the schema, the members, the webhooks, the
automations, locking rows and deleting the base. Nobody could be given
one of those without the others, and nobody reading a check could tell
which one it was (ROADMAP #111).

The screens decided apart from the server, on their own copies of the
ladder (`canWrite`, `canManage`, `role === "owner"`): the two agreed only
as long as both were kept in step by hand.

## Decision

- **A fixed catalogue of permissions** (`PERMISSIONS`,
  `packages/core/src/rbac.ts`), one per act: reading rows, commenting,
  writing rows, deleting them, locking and signing them, exporting,
  importing, publishing, shared views, dashboards, the schema,
  automations, webhooks, members and their rules, and the base itself.
- **The four roles are packs of them** that give exactly what each rank
  gave. A test holds every pack to the rank each act asked before
  (`rbac.test.ts`): moving an act into or out of a pack changes someone's
  access, and is a decision of its own.
- **One decision, `roleGrants(role, permission)`**, asked by every guard
  (`guardTable`, `guardBase`, `tableAccess`, `baseAccess`), the REST and
  MCP surfaces, the public links, the jobs, the sockets, and the screens
  (`grants`, `apps/web/lib/types.ts`). An act that is two acts asks both:
  a base's public link is the base's and a publication, its snapshot is
  the base's and an export, a workbook imported as new tables is an
  import and a change of the schema.
- **A table's role still replaces the base's**, upward or downward,
  exactly as before: the permissions are read from the role that applies,
  never added across the two.
- **Field and row rules** bind everyone but those who may set them
  (`members.manage`).

## Consequences

- No one's access changes with this record.
- Roles made of permissions, chosen by an administrator, come next: they
  are new packs, read by the same function, and need no check rewritten.
- A new procedure names its act. A new act is a line of the catalogue
  and of each pack, and the test asks which ranks held it.
