# 0104 — Two stores are read from a copy, not five

- Status: Accepted
- Date: 2026-11-17
- Amends: 0088; ends the note ADR 0102 made on 0009

## Context

ADR 0088 reads a store that speaks no SQL from a copy, and named five:
the MongoDB wire protocol, OpenSearch, the Redis wire protocol,
Cassandra, and Neo4j. The last three came together, and the product
never said so where people read what it does: its README and its
roadmap name the first two.

AnyGridDB is a spreadsheet on SQL tables. A collection of documents and
an index of them are tables in all but the language: one kind of thing a
row, fields that repeat. The other three are not:

- a key prefix read as a table makes rows of keys that share a spelling,
  not a shape;
- a graph read label by label leaves out its relationships, which are
  what a graph is kept for;
- a Cassandra table read whole, every hour, is the read its own design
  tells people to avoid.

Each of them was also a driver in the image, to follow and to patch (a
fixed advisory in one stops a release, ADR 0100), and a server in the
tests.

## Decision

- **The MongoDB wire protocol and OpenSearch stay**, as ADR 0088 decided
  them: read from a copy, and only from a copy.
- **The Redis wire protocol, Cassandra, and Neo4j are no longer read.**
  Their connectors, their drivers (`ioredis`, `cassandra-driver`,
  `neo4j-driver`), and their servers in the tests are gone. The image
  again carries nothing that speaks Redis.
- **An instance that holds such a source is not upgraded over it.** The
  migration that takes the three engines out of the catalog refuses to
  run while one is declared, and says to delete it with the version
  before. Nothing deletes a base's tables for its owners: an
  administrator who knows what those tables fed does.
- **A new store is a decision of its own.** One connector is little
  code; what it costs is what it promises. A store joins when its
  records are rows, when people ask for it, and with its line in the
  README.

## Consequences

- An operator who declared one of the three deletes it before
  upgrading. Its copies go with it; nothing was ever written to the
  store itself.
- The tests start three servers fewer, and the image holds three
  drivers fewer and what they brought with them.
- What ADR 0088 says of a connector, a copy, and its limits holds for
  the two that stay.

## Rejected

- **Keeping the three and naming them.** It would promise, on the first
  page, a grid over a key-value store and a graph without its edges.
- **Keeping Cassandra alone**, the one whose records are rows. A whole
  read every hour is still the wrong way to read it, and nobody asked.
- **Deleting such sources in the migration.** Their tables may be what
  a base's views, automations, and links stand on: that is for the
  people who run the instance to see before it goes.
