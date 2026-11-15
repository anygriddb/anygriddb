# 0086 — An administration API, with tokens of its own that give no proof

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0038 (provisioning, whose tokens are the model), 0043 (the
  security policy), 0044 (who may hold a token), 0073 (the proof before a
  change), 0083 (what the environment holds)

## Context

Provisioning (ADR 0038) lets an identity provider keep accounts and
groups. An operator also has scripts of their own: put the instance in
maintenance before an upgrade, set a banner, make an account when
someone joins, list the invitations that wait. Administration took a
browser session and nothing else: it refuses the tokens people hold for
their bases, on purpose.

Every change of Administration asks its author for the proof again, the
password or the second factor (ADR 0073). A script has neither.

## Decision

- **Tokens of their own.** `aga_…`, made in Administration by an
  administrator, with the proof. A token shows once, only its SHA-256 is
  kept, and it lives as long as it is asked to, within the policy's
  longest. It works while its maker is an active administrator, and
  what it does is on the trails under their name, as done with a token.
  Any administrator revokes one, at once and without the proof: that
  only takes access away.
- **They open this API and nothing else, and nothing else opens it.** A
  base's token, a provisioning token and a session are refused here; an
  administration token is refused everywhere else.
- **Scopes, named when the token is made.** `accounts`, `invitations`,
  `settings`. A request says which it asks, and a token without it is
  refused, naming the scope.
- **A token does nothing the proof guards.** It gives none, so:
  - an account it makes is never an administrator, and has no role on a
    base: both are given on screen;
  - it changes only the settings of the instance's running, a list
    written out (`API_SETTING_KEYS`): maintenance, the banner, the
    default language, the upload size, the update check, the alerts'
    thresholds, the map's tiles. Who gets in, what an account may do,
    and what the instance says of itself (its name, its sign-in
    message, its mail) are changed on screen. The list says what is
    allowed, so a setting added later is no token's until someone
    decides it is.
- **One way through.** A change made with a token goes through the
  function the screen calls: what the environment holds stays the
  operator's (ADR 0083), and maintenance signs the others out. A new
  account gets its first link as it does from the screen: mailed where
  mail is set up, handed back once where it is not.
- **Plain HTTP and a document.** `/api/v1/admin`, JSON, bearer token,
  the errors of the REST API. `/api/v1/admin/openapi.json` describes it
  in OpenAPI 3.1 and needs no token; it is written from the schemas the
  requests are read with.

## Rejected

- **Giving the tokens people already hold the powers of
  Administration.** A token made to read one base would open the
  instance.
- **A proof on the token's path.** There is nobody to ask.
- **Every power of the screen, behind scopes.** A stolen token would
  then make an administrator, or switch the second factor off for
  everyone. What is left to tokens bounds what a stolen one does: plain
  accounts, a banner, maintenance.
- **Restore points and backups from this API.** Administration's own
  pages do not make them; the API offers what the screen does.

## Consequences

- One table, `admin_tokens`; making and revoking a token is on the
  change trail, without its hash.
- The sign-in trail has a method `admin_token` for an account made, or
  a setting changed, with a token.
- Requests count in the API's rate limit, as the REST API's and
  provisioning's do.
