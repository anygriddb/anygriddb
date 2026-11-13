# 0062 — Files on public forms: kept for the link, claimed by its answer

- Status: Accepted
- Date: 2026-11-13

## Context

A form shared by a public link wrote every field but people
and files. A file reaches a row in two steps: the browser sends it to
`/api/attachments`, which needs an account that may write the table,
then the row names its key. Someone who opens a public form has no
account, so an attachment field could not be on a form at all, and a
table whose attachment field required a value had a public form nobody
could send. Files sent ahead of their answer are also the obvious way to
store bytes on an instance without writing a row: a form left open, an
answer never sent, a script that uploads in a loop.

## Decision

- **The link is the credential.** `POST /api/shares/:token/attachments
?field=<name>` takes one file when the link opens a form (its password
  proof in `x-share-access` when it has one), as its creator, the field
  is an attachment field the form shows, the creator may write it, and
  the table is AnyGridDB's own. Anything else answers 404, whatever the
  reason. The file is stored as any other (written to disk as it arrives,
  the instance's size limit, a slot among the uploads at once, its type
  read from its bytes), under the link's creator, like the row.
- **It waits for that link's answer.** The file's row in `attachments`
  carries the link (`staged_share_id`) and a deadline (`staged_until`, a
  day). Until it is claimed, no member's write may name it, nothing
  serves it (`/api/attachments/:key` answers 404), and the person who
  sent it gets back only its key, name, and size.
- **The answer claims it, once, with the row.** `share.submit` takes the
  keys of an attachment field and writes them through the row service
  (ADR 0022) with the link's id: every key must be a file this link sent
  and no answer claimed, still within its deadline. The claim clears both
  columns in the transaction that inserts the row, so an answer refused
  leaves its files waiting, and a key works for one answer only.
- **A file nobody claims goes.** The hourly purge deletes the files whose
  deadline passed an hour before, rows and bytes; the hour keeps it away
  from an answer being written at the deadline. A link deleted with its
  view takes its waiting files with it, and the orphan sweep removes
  their bytes.
- **A limit of its own.** Files sent to public forms count in their own
  bucket, 30 a minute per client address, a quarter of what members get.
  Logs keep `/api/shares/…`, never the token.
- **Forms in the app take files too:** the form builder offers attachment
  fields, and a member's form sends files as the grid does.

## Consequences

- A public form can ask for a quote, a photo, or a signed page, required
  or not, and the file arrives in the row like any other.
- A form left open longer than a day loses its files: the answer is
  refused with `invalid_attachment`, and the form says to add the file
  again.
- What an instance can hold for files nobody claims is bounded by time
  (a day), size (the instance's limit per file), and rate (30 a minute
  per address), not by a quota per link. A link under attack can be
  revoked; its waiting files go with its view or at their deadline.
- A table read from a client's database takes no file through a form:
  its rows have no attachment field AnyGridDB stores.
