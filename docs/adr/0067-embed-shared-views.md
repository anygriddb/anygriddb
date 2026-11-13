# 0067 — A shared view or form embedded in a site

- Status: Accepted
- Date: 2026-11-13

## Context

Every page AnyGridDB serves says `frame-ancestors 'none'`: a browser
refuses to show it inside another site's frame. That is the right
default: it keeps sign-in, administration, and every signed-in page from
being framed by a site that would trick a click out of someone.

People also want a public view or form on a site they already run: a
portal, a wiki, an intranet page. Allowing frames for the whole app, or
for every site, would reopen that risk. Allowing them for every public
link would let any site frame a share whose address it knows.

## Decision

- **Nothing changes for a link that names no site.** The app and every
  public link keep `frame-ancestors 'none'`.
- **A public link may name the sites that embed it**, when it is made, as
  it is given a password or an expiry: up to twenty addresses, each
  `https://` with a host and an optional port, no path, no wildcard. To
  change them, the link is revoked and another made: the sites are part
  of what the link is.
- **Only that link's page says so.** When the server answers `/s/<token>`
  for a live link that names sites, the page's policy lists them in
  `frame-ancestors`, and nothing else of the policy changes; the
  `X-Frame-Options: DENY` every other answer carries is left out of that
  one. A link that is unknown, revoked, or expired, or whose sites cannot
  be read, is framed nowhere.
- **The browser enforces it.** A site the link does not name gets an empty
  frame. A password-protected link still asks for its password inside
  the frame.
- The dialog gives the frame to paste once the link is made.

## Consequences

- A link whose address leaks cannot be framed by a site it does not name.
- Answers through an embedded form are recorded as the link's other
  answers are, under the name of who made the link.
- A browser that partitions storage for a framed page may ask for a
  protected link's password again at each visit.

## Rejected

- **A setting for the whole instance, or `*`**: every signed-in page
  would be framable by the sites allowed, or by all.
- **Changing a link's sites after it is made**: one more thing to guard
  and to explain, for what a new link does.
