# 0134 — Every way in declares what it asks

- Status: Accepted
- Date: 2026-11-26
- Supersedes: 0126's list of what each part opens (`delegation-rule.ts`),
  0071's list of what an auditor may call besides a read
- Relates to: 0073 (the proof), 0127 (permissions of a base), 0129 (rows
  leave by export)

## Context

Every check named its act since ADR 0127, but nothing said, for a way in,
which acts it asks. A procedure, a route, a socket's message or a job
checked what its body happened to check. Nobody could tell from the code
alone whether a new procedure was guarded, or list what a role reaches
without reading three hundred bodies. Administration kept four lists by
hand beside the code: what the auditor may call, what each part given
apart opens, what support may call (`requireSupport` in some bodies and
not in others), what asks no proof.

## Decision

- **Each way in declares what it asks, where it is defined:** a tRPC
  procedure is built with `asking({ asks, also, filters, exception })`; an
  HTTP route carries `declaredRoute(...)` in its options, or is one of a
  plugin's routes given a door (`doorTo`); the REST API's routes and the MCP
  tools share one table of operations (`OPERATION_ASKS`); a socket's
  message, a task and a kind of job have their line in `MESSAGE_ASKS`,
  `TASK_ASKS` and `JOB_ASKS`, complete by type.
  - `asks` holds on every call, `also` on some (a copy with its rows asks
    for an export), `filters` is what a list leaves out rather than
    refuses.
  - A way in that asks no permission names its **exception**, from one list
    with a reason each (`EXCEPTIONS`, `access/declaration.ts`): signing in,
    an invitation's link, a public link, a mail's unsubscribe link, the
    account about itself, the proof, the instance's own work, what the
    operator reads, the procedures' and the tools' doors.
- **A permission of Administration is a permission too.** A catalogue of
  them (`INSTANCE_PERMISSIONS`, `packages/core/src/rbac.ts`): the helpdesk,
  managing accounts, what reaches a whole account, ending sessions, groups,
  made roles, giving access, overseeing access and bases, creating bases,
  sources and browsing them, settings, operating the instance, reading and
  exporting the trails. Each caller of Administration holds a pack of them:
  an administrator all, support the helpdesk, ending sessions and the
  trails, an account manager the helpdesk, accounts and groups, a source
  manager the sources. `requireAdmin` and `requireSupport` are one check,
  `requireInstance`, that asks what the procedure declares.
- **The auditor's rule stays by what a procedure is:** every read of
  Administration but what reaches out to a client's database, and what the
  auditor's pack holds (the trails' exports). A read added later needs no
  word.
- **A check is held to its declaration.** Every refusal goes through
  `demand` or `granted` (`holds` for Administration), which note the
  permission asked under the way in's declaration. A permission asked and
  not declared fails the tests; on an instance it is logged and counted
  (`anygriddb_undeclared_permission_total`), and the check itself decides.
  `roleGrants` stays for what only filters, and the conventions refuse a
  refusal written from it.
- **Tests walk them all:** `declared.integration.test.ts` fails on a way in
  that declares nothing (the server does not start with such a route);
  `admin-reach.test.ts` holds who may call each procedure of Administration
  to `admin-reach.freeze.json`, and the first one was written from the
  rules this record replaces, with no change.

## Consequences

- No one's access changes with this record: who may call each procedure of
  Administration is what the four lists said.
- The proof is asked only of those a call is open to: support calling a
  change only an administrator makes is refused at once, no longer after a
  proof it could not use.
- A new procedure, route, message, task or kind of job does not compile, or
  does not start, until it says what it asks.
- A job a token started asks its author's roles as they are when it runs,
  as before; what the token was given is still asked when it starts only.
