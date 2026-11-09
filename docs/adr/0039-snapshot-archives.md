# 0039 — Base snapshots carry their files and their people

- Status: Accepted
- Date: 2026-11-08

## Context

A base snapshot (`.anygriddb.json`) held a base's schema, views, and
rows, but left attachment cells and user cells empty: restoring a base
lost its files and who was responsible for what. Files cannot go inside
the JSON: a base's attachments weigh far more than its rows, and base64
in one JSON document would have to be held in memory whole.

## Decision

- **Version 2 of the snapshot format.** Version 1 files still import.
  - Attachment cells name their files: `{ file, name }`.
  - User cells name people by email, as accounts are known everywhere.
  - `members` lists the base's members by email, with their roles.
  - `files` lists each file with its size and SHA-256.
- **An archive when there are files.** A base with attachments exports
  as `<base>.anygriddb.zip`: `snapshot.json` and each file under
  `files/<id>`, stored as it is. Without files, the export stays one JSON
  file.
- **Streamed both ways.** Export writes the archive to a local temporary
  file, file after file, then streams it to the store. An upload is
  written to a local file as it arrives; import reads the archive by its
  central directory, one file at a time.
- **ZIP written by AnyGridDB itself**, with Node's zlib: about 350 lines,
  no dependency. Reading refuses encryption, ZIP64, compression other
  than none or deflate, duplicate names, and entries past the archive's
  end. Every entry's size and CRC are checked, and each file's SHA-256
  against the list.
- **Files are stored again as uploads are**: the type comes from the
  bytes, images get a thumbnail, and each file belongs to its new table.
  A file used by several rows of a table is stored once.
- **People and members.** On import, a user cell keeps the people who
  are members of the new base, found by email. The importer can choose to
  give members with an active account here their role back; nothing else
  grants access. Roles given by groups (ADR 0038) are not carried.
- **A report** counts files missing or damaged, people left out, and
  members without an account. The new base is still created; the person
  is told.

## Consequences

- A snapshot is a real backup of a base, files included, up to 2 GiB
  for the archive and the instance's limit for each file.
- The API needs local disk space for one archive while it is written or
  read: the system's temporary folder.
- An archive is a plain ZIP: any tool can open it and read
  `snapshot.json`.

## Rejected

- **Files as base64 inside the JSON.** A third larger, and held in
  memory whole on both sides.
- **A ZIP library.** The format needed here is small and fully under
  AnyGridDB's control. A dependency would bring far more than it needs.
- **Restoring members by default.** A file someone uploads would then
  decide who sees the new base.
