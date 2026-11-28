# 0142 — A person's attributes in a rule

- Status: Accepted
- Date: 2026-11-28
- Relates to: 0016 (field and row rules), 0038 (SCIM), 0070 (groups),
  0131 (attributions), 0134 (every way in declares what it asks)

## Context

A rule narrows a role on a table to the rows a filter keeps, and "me"
keeps each person to the rows that name them. Since a group's role on a
table takes rules, one rule serves a whole group. What a hospital, a bank
or an administration separates by is rarely the person: it is their
ward, their branch, their department. The row says which ward; the person
belongs to one, sometimes two. Today that takes a group per ward and a
rule per group and table: forty wards and five tables are two hundred
rules, kept by hand. The identity provider already knows each person's
department: SCIM's enterprise extension sends `department`, `division`,
`organization` and `costCenter`, which AnyGridDB lets go.

## Decision

1. **Attributes an instance knows** are a short catalogue in
   Administration › People › Attributes: a key (`ward`), a label
   ("Ward"), and, optionally, the field of SCIM's enterprise extension
   that provides it (`department`, `division`, `organization`,
   `costCenter`). Giving access (`access.grant`) manages the catalogue.
2. **An account's values** are a short list of texts per attribute (a
   person may work on two wards), set on the account's page by whoever
   gives access, or provisioned: an attribute bound to a SCIM field takes
   the provider's value at each provisioning, and is the provider's to
   change. A value removed from the catalogue goes from every account.
3. **A condition may name an attribute** as its value
   (`{ "attribute": "ward" }`), on a text or a single-select field, with
   the operators that keep rows: `is` and `is any of`. Each reader's
   values stand for it, as "me" stands for the reader. A reader with no
   value keeps **no** row by that condition, never every row; an
   attribute the catalogue no longer holds keeps no row either. Saving a
   condition that names an unknown attribute, or one with another
   operator, is refused.
4. **Where:** in the row rules of a table's attributions, a person's or
   a group's, and nowhere else: a view's filter, an automation's
   condition or a form's refuse one, since what they keep is no one's
   access. What acts without a session (a token, an automation, a feed,
   a webhook) reads its author's values at each use.
5. **A change of someone's values, or of the catalogue, changes what they
   reach:** it is on the change trail, and their open pages ask again.
6. **Read only when a rule needs them:** a reader's values are loaded
   with their rules only when a rule that reaches them names an
   attribute, in one query.

## Not now

An attribute in a view's filter ("my ward's rows"), which is a
convenience, not an access; the claims of OIDC and SAML at sign-in, which vary by provider and need a
mapping of their own; an attribute compared to a number or a date; an
attribute in Administration's own rights.

## Consequences

- One rule ("Ward is the reader's ward") serves every ward, and follows
  people as the provider moves them.
- A person's values are as sensitive as their roles: changing them is a
  change of access, and the trail says who made it.
- A rule that names an attribute keeps no row for whoever lacks it: a
  provider that stops sending a department narrows, never widens.
