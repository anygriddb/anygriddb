/**
 * What a signed SAML assertion says beyond who signed in: whom it was meant
 * for, until when the provider's session lasts, and how the person proved
 * themselves. Every function reads the assertion the library verified,
 * never the text the browser posted.
 */
import { AppError } from "@anygriddb/core";

const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const ONE_FACTOR_CLASSES = new Set([
  "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
]);
/** The levels OIDC providers commonly give a password alone. */
const ONE_FACTOR_LEVELS = new Set(["0", "1"]);

type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null;
}

function children(node: unknown, name: string): XmlNode[] {
  if (!isNode(node)) return [];
  const value = node[name];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function attribute(node: unknown, name: string): string | undefined {
  if (!isNode(node) || !isNode(node.$)) return undefined;
  const value = node.$[name];
  return typeof value === "string" ? value : undefined;
}

function assertionOf(parsed: unknown): XmlNode | null {
  if (!isNode(parsed) || !isNode(parsed.Assertion)) return null;
  return parsed.Assertion;
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

/**
 * Whether the assertion was meant for this service: it is confirmed by a
 * bearer confirmation still valid, and one of those names this address. A
 * provider that names no recipient at all is taken at the audience the
 * library checked.
 */
export function samlRecipientHolds(
  parsed: unknown,
  acs: string,
  now: Date = new Date(),
): boolean {
  const subject = children(assertionOf(parsed), "Subject")[0];
  if (!subject) return false;
  const timely = children(subject, "SubjectConfirmation")
    .filter((confirmation) => attribute(confirmation, "Method") === BEARER)
    .flatMap((confirmation) =>
      children(confirmation, "SubjectConfirmationData"),
    )
    .filter((data) => {
      const until = attribute(data, "NotOnOrAfter");
      return until === undefined || Date.parse(until) > now.getTime();
    });
  if (timely.length === 0) return false;
  const recipients = timely
    .map((data) => attribute(data, "Recipient"))
    .filter((recipient) => recipient !== undefined);
  return (
    recipients.length === 0 ||
    recipients.some((recipient) => sameUrl(recipient, acs))
  );
}

/** The earliest end the provider sets on its session, if it sets one. */
export function samlSessionEnd(parsed: unknown): Date | null {
  let end: number | null = null;
  for (const statement of children(assertionOf(parsed), "AuthnStatement")) {
    const text = attribute(statement, "SessionNotOnOrAfter");
    if (text === undefined) continue;
    const at = Date.parse(text);
    if (!Number.isFinite(at)) throw new AppError("invalid_credentials");
    end = end === null ? at : Math.min(end, at);
  }
  return end === null ? null : new Date(end);
}

/** Whether the assertion says the person gave a password and nothing more. */
export function samlAnnouncesOneFactor(parsed: unknown): boolean {
  return children(assertionOf(parsed), "AuthnStatement")
    .flatMap((statement) => children(statement, "AuthnContext"))
    .some((context) => {
      const refs = context.AuthnContextClassRef;
      if (!Array.isArray(refs)) return false;
      return refs.some((ref: unknown) => {
        const text = isNode(ref) ? ref._ : ref;
        return typeof text === "string" && ONE_FACTOR_CLASSES.has(text.trim());
      });
    });
}

/**
 * Whether an OIDC token says one factor was asked: its methods first, then
 * its level. A token that says neither says nothing.
 */
export function oidcAnnouncesOneFactor(
  claims: Readonly<Record<string, unknown>>,
): boolean {
  if (Array.isArray(claims.amr) && claims.amr.length > 0) {
    const methods = new Set(
      claims.amr
        .filter((method): method is string => typeof method === "string")
        .map((method) => method.toLowerCase()),
    );
    return !methods.has("mfa") && methods.size < 2;
  }
  return (
    typeof claims.acr === "string" &&
    (ONE_FACTOR_LEVELS.has(claims.acr) || claims.acr.includes(":1fa"))
  );
}
