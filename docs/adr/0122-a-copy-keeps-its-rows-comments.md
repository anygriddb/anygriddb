# 0122 — A copy the instance makes keeps its rows' comments

- Status: Accepted (amends 0117)
- Date: 2026-11-24

## Context

A restore point, a copy of a base, and a copy of a table with its rows keep
each row's dates, authors, and status (ADR 0117), but not the comments on the
rows. A base restored after a bad change came back without the discussion
that explained its rows, and a copy made to try something out started with
none.

A comment says who wrote it. A file brought from elsewhere could name any
account of this instance as the author of anything: imported as it is, it
would let anyone write a comment in someone else's name.

## Decision

- **The instance's own copies carry the comments.** A version 4 snapshot
  writes each table's comments in an entry of their own,
  `comments/<key>.ndjson`, one line each: the number of the row it is on, its
  author and its resolver by their ids, its body, its dates of writing, of
  edit, of removal and of resolution, and the comment it answers. The table
  says how many lines the entry holds; a table without comments has no entry.
- **Read back, each comment goes on the row that took its number,** a reply on
  the copy of what it answers, with its authors and dates as they were. A row
  added while the copy was written, after its rows were read, leaves its
  comments behind with it.
- **An account erased since the copy is the erased account's placeholder,**
  as its erasure made it everywhere else; a resolver erased since is
  forgotten, as a resolver's account is when it goes.
- **A table copied with its rows copies its comments** in the database, range
  by range, each onto the row of its number.
- **A file a person downloads carries none, and no file brings any.** An
  export stays version 3, and version 4 is still refused from a file (ADR
  0117), so a comment's author is believed only where the instance wrote it.
- **Nothing is sent and nothing is counted again:** a copied comment notifies
  nobody and is not mentioned in the copy's history.

## Consequences

- A restore point made before this version holds no comments: its base comes
  back without them, as before.
- A version before this one cannot read a restore point of a base with
  comments written by this one.
- A copy's archive holds up to two entries per table, and is opened with that
  bound.
