import { AppError } from "@anygriddb/core";
import { isIP } from "node:net";

/**
 * Whether `PUBLIC_URL` can be a WebAuthn RP ID: a DNS hostname or
 * `localhost`, never a bare IP (ADR 0029).
 */
export function passkeysEligible(origin: string): boolean {
  try {
    relyingParty(origin);
    return true;
  } catch {
    return false;
  }
}

/**
 * WebAuthn relying party for this instance. The RP ID is the hostname of
 * `PUBLIC_URL`. Browsers refuse a bare IP address (`OriginMissingDomain`):
 * passkeys need a DNS name, or `localhost`.
 */
export function relyingParty(origin: string): { rpID: string; origin: string } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AppError("invalid_origin");
  }
  const localhost = url.hostname === "localhost";
  // WHATWG hostnames keep IPv6 brackets (`[::1]`); strip them for isIP.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(localhost && url.protocol === "http:")) ||
    isIP(host) !== 0
  ) {
    throw new AppError("invalid_origin");
  }
  return { rpID: url.hostname, origin: url.origin };
}
