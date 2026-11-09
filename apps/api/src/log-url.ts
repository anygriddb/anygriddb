/**
 * Paths whose last part is a secret: a public share, an invitation, a
 * calendar feed, a webhook automation's address.
 */
const SECRET_PREFIXES = ["/s/", "/invite/", "/ical/", "/hooks/automations/"];

/**
 * A request's address as logs keep it: the secret part of a path that has
 * one masked, and no query string, which carries tRPC inputs (share tokens,
 * searches) and other people's words.
 */
export function logUrl(url: string): string {
  const query = url.search(/[?#]/);
  const path = query === -1 ? url : url.slice(0, query);
  const rest = query === -1 ? "" : "?…";
  const prefix = SECRET_PREFIXES.find((item) => path.startsWith(item));
  return prefix ? `${prefix}…${rest}` : `${path}${rest}`;
}
