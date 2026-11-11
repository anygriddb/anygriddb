# 0058 — A sign-up proves its address before the account exists

- Status: Accepted
- Date: 2026-11-11

## Context

A password sign-up made the account and opened a session at once, without
proving the address, and sign-up is open by default. Several things trust
an account because of its address: `ADMIN_EMAILS` makes it an
administrator, an owner gives a role by typing an address, and OIDC, SAML
and SCIM find an account by its address the first time they meet it. So
whoever signed up first with someone else's address received what was
meant for that person: administration, a base, or the binding of the real
person's single sign-on identity to an account whose password the first
one chose.

## Decision

- **No account before the proof.** Past the instance's first account, a
  password sign-up keeps a request (`signup_requests`: address, name,
  Argon2id hash of the password, SHA-256 of a link token, a day of life)
  and mails a link to the address. The account is made when the link is
  opened and the password chosen at sign-up is given again; the person is
  then signed in, and every other request for the address goes.
- **The password is asked again on the link's page.** The link proves the
  mailbox; the password proves the person who opens it made the sign-up.
  A sign-up someone else made with your address cannot become an account
  you use with a password they know: you cannot open their link.
- **Made at once**, as before: the first account, which sets the instance
  up, and a sign-up that comes from an invitation's link for that very
  address (the invitation reached it).
- **The same answer for every address.** An address that has an account
  gets "check your email", like any other, and a mail saying an account
  exists already. The page no longer tells who has an account.
- **Bounded.** At most three live requests per address, after which a
  sign-up mails nothing more; the link's page is counted as a public link,
  its confirmation as a sign-in; expired requests are deleted hourly.
- **Without email**, an instance cannot prove an address: a sign-up past
  the first account is refused (`signup_needs_mail`). People get in by an
  invitation's link, or by an account an administrator creates.
- Nothing else changes: every account row is now proved (or was made by an
  administrator, SCIM, or a provider that vouches for the address), so
  `ADMIN_EMAILS`, roles by address, and SSO and SCIM matching keep their
  rules.

## Rejected

- **An unproved account that can sign in, with whatever is given by
  address held back until the proof.** Every place that trusts an address
  would have needed its own check, now and in every feature to come, and
  the unproved account still showed the address to others.
- **Choosing the password on the link's page.** Simpler to explain, but the
  form would change shape between the first account and the others, and
  the first account and invitations still need a password on the form.
- **Keeping immediate sign-up when the instance sends no email.** It keeps
  the weakness exactly where operators least expect it.

## Consequences

- Accounts made before this change are not re-proved: an instance that had
  open sign-up should review its accounts.
- Open sign-up now needs email set up; the sign-in page says so when a
  sign-up is refused for it.
- `/signup/<token>` joins the secret links that logs mask and search
  engines skip (`/reset/<token>` too, which was missing).
