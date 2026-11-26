# 0136 — A file no cell holds is released, and storage has quotas

- Status: Accepted
- Date: 2026-11-26
- Relates to: 0132 (one catalogue of limits, its storage family), 0062
  (files sent to a form), 0077 (restore points), 0069 (what the trail keeps)

## Context

A file put in a cell is a row of `attachments`, kept while its table lives.
Taking it out of the cell kept the row and the stored object: a base at a
quota could free nothing by removing files, so ADR 0132 left the quotas of
storage (ROADMAP 38) until files were released.

What may still need a file a cell let go: the same cell's change undone
from its history, its row restored from the trash (a row in the trash is
kept in the change trail, not in its table), a field restored from the
trash (kept in its table). What does not: a restore point and a snapshot carry their own
copy of each file, and a base copied or imported gets files of its own
(`storeAttachment`).

## Decision

- **A file is held while a cell names it**, in a row of its table, in a
  field or in a field in the trash. A row in the trash lives in the change
  trail: its files are released, and come back held with the row the trash
  restores.
- **One that no cell names is released**: `attachments.released_at` says
  since when. A release does not delete it at once: for as long as the trash
  keeps what is deleted (`retention.trash_days`), undoing the change that
  took it out finds it again, and naming it again holds it again. After
  that its row is deleted, and the nightly sweep removes the stored object
  and its thumbnail, as for any file no row names.
- **Who looks:** a job per table (`file_release`), queued a few seconds
  after a change takes a file out of a cell (one job however many changes),
  and every night for every table that has files. It reads the keys its
  cells name, page by page, and compares: nothing is read at the change
  itself, which stays as fast as before.
- **Storage is what is held:** a base's is the size of the files its tables
  hold, an account's of the files it sent and that are held. Released files
  count for nobody.
- **Two quotas, in the catalogue** (`storage.base_bytes`,
  `storage.account_bytes`), set in Administration › Limits and usage; 0, the
  default, is none. A file is refused when it would take its base or its
  sender past one (`storage_full`, which names which): a file sent to a
  cell, to a form, brought by an import, a copy or a snapshot.
- **What is shown:** Limits and usage gives, beside each quota, the most a
  base or an account holds; the list of bases keeps each base's size, now
  of what it holds.

## Consequences

- Taking files out of cells frees a base's storage within the minute.
- A change undone after the trash's days finds the file it named gone: the
  cell names a file that is no longer kept, and shows nothing of it.
- An instance with no quota set refuses nothing it accepted before.

## Rejected

- **Looking at the change itself** whether another cell still names a key:
  a scan of the table on each change that takes a file out, in the path of
  every write.
- **Counting a reference per file:** every write path, import and copy
  would have to keep the count right; a miss deletes a file a cell still
  names.
