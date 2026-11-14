# 0081 — An account's data exported as a file

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0051 (account erasure), 0074 (an administrator's way into
  a base), 0075 (handing over), 0069 (the change trail kept for a time)

## Context

An administrator is asked what the instance holds about one person: a
person who leaves, a person who asks, a review. The answer was spread
over the account's page, the sign-in trail, and the change trail, each
read by hand.

Two things could go wrong in putting it in one file. The change trail
keeps the whole row before and after each write, and comments keep their
text: copied into the file, they would hand an administrator what people
typed in bases that administrator may not open (ADR 0074). And a long
trail holds tens of thousands of events: read whole, they would fill the
worker's memory.

## Decision

- **A background job** (`account_export`) writes one JSON file for the
  administrator who asked, kept a day as every export is, and fetched
  from their tasks.
- **What it holds:** the profile; the roles on bases and on tables, with
  the group that gave each; the groups; the open sessions; the API
  tokens by name, limits, and dates; the sign-in and account events
  where the account is the author or the subject; the comments it wrote,
  by table, row, and date; its writes, by table, row, action, and the
  names of the fields changed.
- **What it leaves out:** cell values, comment texts, attached files,
  the password, the tokens themselves, and the second factors. What is
  typed in a base is that base's: it is read by its members, and erased
  or kept by its managers (ADR 0051). The file's first lines list both.
- **The fields changed, not the fields of the row.** A field is named
  when its value differs between the row before and the row after; for a
  row made, when the row filled it.
- **Written a page at a time.** Each long list is read newest first, 500
  lines at a time, each page starting after the last line of the one
  before. A list stops at 10,000 lines, and the file says for each list
  how many lines it holds and whether lines were left.
- **On the sign-in trail.** A finished export leaves
  `account_data_exported`, with the administrator as its author and the
  account as its subject.
- **On the account's page:** the counts, the last writes and account
  events, and the action that starts the job. An auditor reads the page
  and starts nothing (ADR 0071).

## Rejected

- **Cell values and comment texts in the file.** The file would open
  every base the person wrote in to whoever administers the instance.
- **A file that calls itself the answer to an access request.** What
  such an answer must hold is for the instance's operator to say, with
  what the bases hold; the file is an export of what AnyGridDB knows of
  the account, and says so.
- **Support starting it.** Support helps a person sign in again
  (ADR 0054); this leaves the instance under an administrator's name.
- **Reading by offset.** Events written while the file is made would
  shift the pages, and a line would come twice or not at all.

## Consequences

- Migration `0094` adds the job's kind, the trail's action, and two
  indexes: the events an account made on other accounts, and the
  comments an account wrote. The export reads both, and an account's
  erasure rewrites both; each read the whole table before.
- A list cut at 10,000 lines is not whole. The file says so; the trails'
  own exports, by date, give the rest.
- The download is the one of every export: the job's file, for the
  account that started the job.
