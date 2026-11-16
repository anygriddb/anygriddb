# 0101 — A script calls an address through the instance, with secrets it never holds

- Status: Accepted
- Date: 2026-11-16
- Amends: 0099

## Context

ADR 0099 gave automations scripts that read and write the rows of their
base and open no connection. It left calling an address out: a script
that fetches needs what webhooks have (public addresses only, pinned,
bounded), and most addresses worth calling ask for a key. A key written
in the script would be read by everyone who may edit the automation and
kept by the change trail, which records the script's text.

## Decision

- **`fetch(url, { method, headers, body })` in a script** asks the API
  process to make the call; the script's own process still opens no
  connection. The call goes out as a webhook's does: HTTPS only, to a
  public address, the name resolved once and the connection made to
  what it resolved to, ten seconds at most. A redirect is answered as it
  is, never followed. The answer comes back as its status, its headers,
  and its body as text, one mebibyte at most. Ten calls a script. A
  call that gets no answer is an error the script may catch, told in
  the words a webhook's delivery uses (a blocked target, an unknown
  host, a timeout), and nothing of the failure itself.
- **An automation keeps secrets**, ten at most, each with a name and the
  one host it is for. They are sealed with the instance's key, in the
  automation's own row, under a use of their own (`automation`); the key
  rotation seals them again with the rest.
- **A secret is written by name and put in by the instance.** A script
  writes `{{secret.NAME}}` in a call's address, a header, or the body.
  The API process reads where the call goes from the address as the
  script wrote it, checks that each secret named is kept for that very
  host, puts the values in, and checks again that the call still goes
  there. The value never enters the script's process: a script that
  returns or logs the text gets the name it wrote.
- **A secret is never shown again.** The editor and the API say its
  name, its host, and when it was set. Saving an automation without
  naming its secrets leaves them; naming one without a value keeps it,
  for the same host only. A secret sent to another host, or a new one,
  is given its value again: whoever may edit an automation cannot point
  a secret someone else typed at a host of their own.
- **The change trail names secrets and holds none**: the list of names
  and hosts is on it, the sealed column is not.
- Calls and secrets follow the same switch as scripts
  (`automationScripts`).

## Consequences

- Migration 0115 adds the three columns to `automations` and takes the
  sealed ones out of what the trail records.
- A secret is as safe as its host: a host that echoes what it is sent
  gives the value to the script that called it, and whoever may edit the
  automation may call that host with it.
- A header a call sets itself (`Host`, `Content-Length`, and those that
  frame a connection) cannot be written by a script, and a header of two
  lines is not sent.
- Calls are not counted against the automation's 300 runs a minute: ten
  a script, and the scripts of a run share a minute.

## Rejected

- **A secret given to the script as a value.** It would be one
  `console.log` from the run log, and one line of script from any
  address.
- **Secrets of the base, shared by its automations.** Any manager's
  script could then spend a key another manager typed.
- **Following redirects.** The host a secret is for is read from the
  address before the call; a redirect would carry what was sent
  somewhere that was not checked.
- **Private addresses behind a setting**, as notification channels have.
  A script is written by a table's manager, not by an administrator: it
  calls what a webhook may.
