# 0077 — Restore points: a base kept on the instance, restored beside it

- Status: Accepted
- Date: 2026-11-14
- Relates to: 0039 (files and people in snapshots), 0076 (snapshot rows as
  lines), 0069 (the change trail kept for a time)

## Context

A base's manager about to make a risky change (an import that updates
rows, a type change, a bulk edit) could already download the base's
snapshot and import it again if things went wrong. Each step was theirs
to do: keep the file somewhere, find it again, upload it, choose to give
the members back. A snapshot imported that way gave members their roles
back on the base, but not their own roles and rules on its tables: a
member who did not see a field in the base saw it in the copy
(ROADMAP row 99).

## Decision

- **A restore point is a snapshot with its data** (version 3, ADR 0076):
  rows, links, files, views, members, kept in the files' store under
  `restore-points/<id>`, with a line in `restore_points` (its base, who
  made it, when, until when, its size, rows, files, and a note of up to
  200 characters). It is made by a manager of the base, in a job, up to
  `EXPORT_MAX_ROWS`, and is on the change trail as an export of kind
  `restore_point`.
- **Kept for a time the administrator sets.** `restorePointDays`, from 1 to
  365 days, 30 by default, set on Administration's Security page. A
  shorter length also brings forward the end of the points already made,
  as the trash's does; a longer one applies to the points made after it.
  A point that has ended is neither listed nor restored, and the nightly
  purge deletes its line, then its file. A base keeps 20 points at most: one more is refused until one
  is deleted or expires. A base purged from the trash takes its points
  with it, files included, and the orphan sweep knows their keys.
- **Restoring makes a new base, beside the old one.** The base is never
  overwritten: its rows written since stay, and the two can be compared.
  The new base is named after the old one, "(restored)" in the asker's
  language, and needs the second factor a new base does.
- **Access as it was, for those still in the base.** The members who had
  a role when the point was made get it back, and with it their own role
  and rules on each table, if they are still in the base now, directly or
  through a group; the others are left out, and the job's report says how
  many. The base's groups get the role they have on it now: a snapshot
  keeps no group, which belongs to the instance. People in Collaborator
  fields stay where they are members of the new base.
- **Snapshots carry each person's access to a table.** A snapshot with
  data now keeps, for each table, each person's own role there and their
  row and field rules, by email. An import that gives members their role
  back gives these back too, so that nobody sees more of the new base than
  they saw of the old one. A rule that no longer reads hides every row, as
  in the grid.
- **Two jobs, `restore_point` and `restore_base`,** each checked against
  its author's current rights when it starts, and retried by their author
  after a failure: a point keeps its file only once its line is written,
  and a restore that fails removes the base it began.

## Consequences

- Each point takes the room of its archive in the files' store, and the
  backups of the store carry it.
- The Backup section of a base still exports a file to keep elsewhere: a
  restore point lives and ends with the instance.
- A restore point made before a member left still holds the rows that
  member could read then; restoring it gives them no access.

## Rejected

- **Restoring in place.** The rows written since the point would be lost,
  and every link, comment, and view pointing at a row would have to be
  remapped; a new base beside the old one loses nothing.
- **Members' roles alone, as the import gave them.** Without their rules,
  a member would see fields and rows of the restored base that the base
  hid from them.
- **Members as they are now.** The data is from the point; giving it to
  people who came since would show them rows they never had. Taking the
  members of then, less those who left, gives nobody what they did not
  have.
- **Keeping points for ever, or without a ceiling.** Each one is a copy
  of the whole base: a time and a number bound the store.
