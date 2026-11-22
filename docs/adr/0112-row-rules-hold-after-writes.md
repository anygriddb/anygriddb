# 0112 — A row rule holds for what a row becomes

- Status: Accepted
- Date: 2026-11-22
- Amends: 0016 (field and row rules are enforced by the read engine)

## Context

ADR 0016 had writes check that their rows were inside the writer's rule. It
asked about the rows as they were. A new row had nothing to ask about, and an
update was not compared to the rule once applied: someone limited to one
region could create a row in another, which they could not then see, or move
one of theirs out of their reach, with no way to bring it back.

## Decision

- **The rule is asked of the rows as written, before the write commits,** in
  the write's own transaction. A row it does not keep refuses the whole write
  with `row_outside_rule`, and nothing changes. This holds on AnyGridDB's own
  tables and, inside the client's transaction, on a client's.
- **A link write is asked the same**, so a link a rule depends on cannot be
  removed.
- **A new row with links is asked once they are written,** since its links are
  written after it. If the rule does not keep it, it goes to the trash, where
  its writer does not reach it, and the write is refused.

## Rejected

- **Checking the values before writing.** A rule can read a formula, a lookup,
  or a link: only the row as stored answers for all of them.
- **Letting a writer move a row out on purpose.** A rule says what someone may
  reach. Handing a row over belongs to someone with no rule on it.

## Consequences

A writer who should hand rows to another team needs a rule that covers both,
or someone without a rule to do it.
