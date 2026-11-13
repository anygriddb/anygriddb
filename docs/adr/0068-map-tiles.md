# 0068 — Map tiles from a server the operator names

- Status: Accepted
- Date: 2026-11-13

## Context

The map view places rows on a plain projection, with no map under them.
A basemap is made of tiles, images fetched from a tile server as the
view needs them. Images from outside the instance widen the page's
policy (`img-src`), each tile asked tells that server which places
people look at, and a tile server's terms ask that its maps be credited.

## Decision

- **None by default.** `mapTileUrl` is empty until an administrator
  sets it in Administration: maps keep their plain background, and the
  instance asks nothing of anyone.
- **One server, over HTTPS.** The setting is an address with `{z}`,
  `{x}`, and `{y}` where a tile's zoom, column, and row go, and nothing
  in it that signs in. The page's policy adds that one origin to
  `img-src`, and only while the setting holds it.
- **The credit is a setting too**, `mapTileCredit`, shown on every map:
  the operator who chooses a server knows what its terms ask.
- **No map library.** The view works out the tiles that cover its points
  in Web Mercator and draws them as images under the pins, sent without
  a referrer. Scripts stay the app's own.
- **A shared map follows the same setting**: there is no tile server per
  view.

## Consequences

- An operator who names a tile server chooses whom the instance's people
  tell where they look. The setting's own text says so.
- The policy is the page's: a page open before the setting changed shows
  the map once reloaded.
- The map does not pan or zoom: it shows the rows of the view, as before.
- A wrong address shows no background; the pins still place.

## Rejected

- **A public tile server by default**: every map would tell a third
  party where people look, on instances that never chose it.
- **A map library**: scripts and styles to carry and to trust, for what
  positioned images do.
- **Tiles fetched by the server and passed on**: the browser would tell
  the tile server nothing, but every install would carry the traffic and
  a cache, and most servers' terms forbid it.
