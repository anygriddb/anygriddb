# 0072 — The instance's own name, logo, and mail voice

- Status: Accepted
- Date: 2026-11-14

## Context

Every instance called itself by the product's name: on the sign-in
pages, at the top of the app, in the browser's tab, and in every mail,
which left from a bare address. An organisation that runs an instance
for its own people wants them to recognise it: its name and logo where
they sign in, a word on who it is for, and mail that says who sends it.

## Decision

- **Seven settings, with the others** (`instance_settings`): the
  instance's name, a note on the sign-in pages, the sender name of its
  mail, a signature and a note for invitations in each language mail is
  written in. Names go on one line and take no control character: they
  end up in a mail header. Null keeps what the product did before.
- **The logo is one row** (`instance_logo`): the image, its type, and a
  version made from its bytes. It is part of how the instance is set up,
  as its settings are, so it lives with them and travels in the
  database's backup. PNG, JPEG, or WebP, 256 KiB at most. The type kept
  and served is what the first bytes prove, never what the upload says
  of itself.
- **The logo is set through Administration's own procedures**
  (`admin.setLogo`, `admin.removeLogo`), base64 in the request: every
  guard of Administration holds for it without a line of its own (an
  administrator's own session, a second factor, no API token, support
  and auditors refused), and the change is on the sign-in trail.
- **Anyone reads it**, at `/api/instance/logo`: the sign-in page shows
  it before anyone signs in. Asked for by its version it never changes,
  and a browser keeps it a year; asked for without, it is checked again
  each time.
- **One mark on the screens.** The four places that drew the product's
  mark (sign-in pages, the app's navigation, an invitation, a shared
  view) draw the instance's: its logo in the mark's square, its name
  beside it where a name stood.
- **The app's explanations still name the product.** Where a sentence
  says what the software does (it never changes a client's table, a
  field is kept in it), it speaks of the software, under its own name.
- **One voice in mail.** Every mail is written and sent with the same
  value: the reader's language, the instance's name where the product's
  was, the sender name before the address (the instance's name when no
  sender name is set), and the signature after the text, under the line
  mail readers know (`-- `). The mailer takes the voice as an argument,
  so a mail added later cannot leave without one.
- **An invitation keeps its link.** The instance's note is a paragraph
  between who invites and the link; the link and the day it expires are
  written by the product, whatever the note says.
- **What a person wrote stays as written.** The mail of an automation
  and a webhook's payload leave under the instance's sender name, with
  no signature: the first is its author's text, the second is read by a
  program.

## Rejected

- **The logo in the file store.** The store holds what people put in
  cells, swept when nothing refers to it, and may sit on another
  machine: a public page would wait on it, and the logo would need an
  exception to the sweep and to the names files take there.
- **A route of its own for the upload** (multipart). It would carry its
  own copy of Administration's guards, and one of them would be
  forgotten: the first draft checked the administrator and not their
  second factor.
- **SVG.** A drawing made of markup, served to every visitor, can carry
  a script.
- **A template for the invitation**, with placeholders for the link and
  the date. An administrator could leave the link out, and the mail
  would invite to nothing.
- **The sender name and signature given at each place that sends.** The
  first draft did so for two mails out of sixteen.

## Consequences

- `auth.instance` (public) carries `instanceName`, `signInMessage`, and
  `logo` (the version, or null).
- `sendMail` takes the voice between the relay's settings and the
  message; the functions that write mail take it where they took a
  language.
- A French notification no longer says "hors d’AnyGridDB": the name may
  start with any letter, so the sentence does without the elision.
