# 0083 — What the environment sets, Administration shows and cannot change

- Status: Accepted (amends 0050)
- Date: 2026-11-15
- Relates to: 0050 (operator integrations in the UI), 0080 and 0082
  (what only the operator can do)

## Context

ADR 0050 let an administrator set email and single sign-on in
Administration, and made a saved row win over the environment. It
rejected the other order, saying an operator who wants the environment to
decide leaves the page empty.

Nothing kept the page empty. Any administrator, or whoever took an
administrator's session, could save a row and move the instance's sign-on
to another provider, or its mail to another relay, over what the operator
had written where the instance is installed. And the page gave no sign of
it: an operator who changed a variable saw nothing change.

The same order held for the largest attachment.

## Decision

- **The environment wins when it sets a whole configuration**: SMTP (a
  host and a sender), OIDC (its four variables), SAML (its four), and
  `ATTACHMENT_MAX_BYTES`. Otherwise the row saved in Administration
  applies; otherwise none. Half a configuration in the environment is
  none, as before.
- **Administration shows what is in force**: the relay's host, port,
  account and sender, the provider's issuer and client, never a password
  or a secret. It says the instance's environment sets it and that its
  operator changes it there.
- **A save is refused**, by the server, with `set_by_environment`: the
  page offers none, and a call made past the page changes nothing.
- **A row saved before stays, unused**, and the page says so. It can be
  cleared from there. Removing the variables puts it back in force.
- The largest attachment the environment sets is listed with what the
  operator fixed (Administration, Instance), and its field is off.

## Rejected

- **Keeping the saved row first.** The operator's file would hold only
  until an administrator, or a stolen session, saved the page.
- **Merging the two**, a variable at a time. A relay from one place with
  a password from the other is a configuration nobody wrote.
- **Copying the environment's values into Administration** at the first
  start or on request. A secret would be written a second time, and the
  two would part at the next change.
- **A warning at start when both exist.** The page where the row is kept
  says it to the person who can clear it.

## Consequences

- An instance that sets no such variable is unchanged: the Compose files
  pass none for email and single sign-on, which are set in Administration.
- An instance that both set the variables and saved the page follows the
  variables from this version on. No version was published with the other
  order.
- `resolveSmtp`, `resolveOidc`, `resolveSaml` and
  `resolveAttachmentMaxBytes` read the environment first; their callers
  are unchanged.
