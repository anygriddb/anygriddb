# 0126 — Parts of Administration given apart: an account manager, a source manager

- Status: Accepted; superseded in part by 0131 (its roles are attributions at the instance)
- Date: 2026-11-25
- Relates to: 0054 (support, and its reach), 0071 (the auditor), 0073 (the proof)

## Context

Administration had three kinds of people: administrators, who do
everything; support (ADR 0054), who help a person sign in again; and
auditors (ADR 0071), who read everything and change nothing. An
organisation that wants someone to add people, or someone to connect its
client databases, had to make them administrators, with every setting,
every role and every account in their hands (ROADMAP #34).

The question left open was which changes each may make, and how one
rule says it.

## Decision

- **Two roles, rows of `instance_roles`:** `account_manager` and
  `source_manager`. An administrator gives and takes them away, with the
  proof, each change on the sign-in trail (`account_updated`,
  `<role>_granted` or `<role>_revoked`). They add to what the account
  already is; an administrator needs neither. An erased account takes its
  roles with it.
- **One rule, a list of what each part opens** (`delegation-rule.ts`). A
  procedure of Administration not named there stays an administrator's,
  so one added later is closed to these roles without a word. The proof,
  the session rules and the refusal of API tokens are those of every
  caller of Administration.
  - **Accounts and groups** (account manager): the list of accounts and
    one account's page, adding a person, their name and address,
    disabling and enabling them, their sessions, and what a helpdesk does
    (a reset link, unlocking, second factors, single sign-on, API
    tokens); the groups and who is in them.
  - **Sources** (source manager): the client databases, what they expose,
    their writes, their watch and their copies. A table is brought only
    into a base the source manager owns.
- **Never opened to either:** giving a role of Administration, giving a
  role on a base (a group's included, a person made with bases, a file of
  people), deleting an account, acting as someone, handing over what a
  person owns, taking a person's data out, the settings, the trails, and
  what acts on the whole instance at once.
- **Reach.** An account manager, as support, acts only on an account
  that holds no role of Administration (`helpdeskReach`): an
  administrator, support, an auditor, or another holder of these roles
  is refused with `account_out_of_reach`. Nobody acts as an account that
  holds one of these roles.
- **Screens.** Administration shows each person the sections of their
  part: an account manager the first page, the accounts, the groups and
  the sessions; a source manager the sources. An act a person may not
  take stays listed, off, with its reason. A group's roles on bases are
  shown and not changed.

## What an account manager can reach

Changing an account's address, then sending it a reset link, gives the
account manager that account, as support has had on an instance without
mail. So an account manager can sign in as anyone who holds no role of
Administration, and reaches every base those people reach; and adding a
person to a group gives them what the group holds. Every step is on the
sign-in trail. This is the role: give it as you would give those
passwords.

## Rejected

- **A permission per procedure for every caller, and custom roles of
  them.** The catalogue of permissions proposed with this work holds for
  a later change to base roles (roles of a base made of permissions, given
  apart): for Administration it would say in two hundred lines what two
  lists say, and a role made by hand could give a part that climbs
  (accounts without the reach rule).
- **Two more columns beside `is_admin`, `is_support` and `is_auditor`.**
  A role is a row: the next one is a value, not a migration of `users`.
  The three older roles stay columns; they are read in the session, the
  sign-in and the database, and move only when that is worth its change.
- **Letting an account manager give a group a role on a base.** Access to
  a base is its owners' and an administrator's to give.
- **Letting a source manager bring tables into any base.** A base's
  tables are its owners'.
