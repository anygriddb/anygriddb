# 0096 — The app shows its license, and ships its libraries' licenses

- Status: Accepted
- Date: 2026-11-16
- Relates to: 0019 (one image), 0011 (the app the API serves)

## Context

AnyGridDB is under the AGPL, and what it ships holds several hundred
libraries under licenses that ask for their notice and text to go with
every copy. The built app held none of them, the image held those of the
API's libraries only, and no screen said under which license the
software comes, that it comes without warranty, or where its source is.
The AGPL asks an interface to show such notices, and asks whoever runs a
changed version to offer its source to the people who use it.

## Decision

- **The web build writes two files**, from what was installed
  (`scripts/third-party-licenses.mjs`): `license.txt`, AnyGridDB's own
  license, and `third-party-licenses.txt`, which names each library the
  product ships, its version, its license, and the text its package
  carries. A text already printed is named, not repeated.
- **The app serves them and the image holds them**: they are part of the
  build, like any other file of the app.
- **"About AnyGridDB"**, in the account menu and on the sign-in page,
  says whose work this is, that it comes without warranty, under which
  license, and links to the source and to both files.
- **The source's address is one constant** (`SOURCE_URL`): whoever runs
  a changed version names their own there before building.

## Consequences

- The list is what pnpm reports for the dependencies of the API and of
  the app: a library that states its license wrongly is listed wrongly.
- A public link's page shows no such notice yet: it has no menu to put
  one in.

## Rejected

- **A file kept by hand in the repository.** It would lag behind the
  first dependency update.
- **Keeping license comments in the bundled scripts.** Most packages
  carry their license in a file, not in a comment.
- **A setting for the source's address.** A changed version is rebuilt
  anyway; a setting would let an unchanged one point elsewhere.
