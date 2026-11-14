/**
 * The instance's encryption keys (ADR 0066): the key in use, named by an
 * identifier, and the earlier ones kept while what they sealed is being
 * rewritten. Nothing is ever encrypted or signed with a master key itself:
 * each use takes a key of its own, derived from the master, so that what
 * one use leaks opens nothing of another.
 */
import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** What a key is derived for. Each use has its own key under each master. */
export type KeyUse =
  | "totp"
  | "sso-state"
  | "oidc"
  | "smtp"
  | "siem"
  | "webhook"
  | "source"
  | "tls"
  | "job-token"
  | "backup-code"
  | "share-access";

export type KeyRing = {
  /** The identifier written on what is sealed from now on. */
  currentId: string;
  /** Every master this process holds, the current one first. */
  masters: ReadonlyMap<string, Buffer>;
};

/** The identifier of a key given without one. */
const DEFAULT_KEY_ID = "0";

const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** `base64`, the key of an instance that never named one, or `id:base64`. */
function parseKey(text: string, name: string): { id: string; key: Buffer } {
  const value = text.trim();
  const colon = value.indexOf(":");
  const id = colon < 0 ? DEFAULT_KEY_ID : value.slice(0, colon).trim();
  if (!KEY_ID.test(id)) {
    throw new Error(
      `${name}: a key identifier is 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }
  const key = Buffer.from(value.slice(colon + 1).trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be 32 bytes, base64-encoded`);
  }
  return { id, key };
}

/**
 * The ring an operator's settings describe: the current key, then the
 * earlier ones, separated by commas. Two keys cannot share an identifier.
 */
export function parseKeyRing(current: string, previous = ""): KeyRing {
  const first = parseKey(current, "AUTH_ENCRYPTION_KEY");
  const masters = new Map([[first.id, first.key]]);
  for (const part of previous.split(",")) {
    if (part.trim() === "") continue;
    const { id, key } = parseKey(part, "AUTH_ENCRYPTION_PREVIOUS_KEYS");
    if (masters.has(id)) {
      throw new Error(
        `AUTH_ENCRYPTION_PREVIOUS_KEYS: the identifier ${id} is given twice`,
      );
    }
    masters.set(id, key);
  }
  return { currentId: first.id, masters };
}

/** A ring of one key, as an instance that never changed its key has. */
export function keyRing(master: Buffer, id = DEFAULT_KEY_ID): KeyRing {
  if (master.length !== KEY_BYTES) {
    throw new Error("An encryption key must be 32 bytes");
  }
  return { currentId: id, masters: new Map([[id, master]]) };
}

/** A new master key, as `AUTH_ENCRYPTION_KEY` takes it. */
export function mintKey(id: string): string {
  if (!KEY_ID.test(id)) {
    throw new Error(
      "A key identifier is 1 to 64 letters, digits, dots, dashes or underscores",
    );
  }
  return `${id}:${randomBytes(KEY_BYTES).toString("base64")}`;
}

function derive(master: Buffer, use: KeyUse): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, Buffer.alloc(0), `anygriddb:${use}`, KEY_BYTES),
  );
}

function currentMaster(ring: KeyRing): Buffer {
  const master = ring.masters.get(ring.currentId);
  if (!master) throw new Error("The key ring has no current key");
  return master;
}

/** The key new values of this use are sealed or signed with. */
export function currentKey(
  ring: KeyRing,
  use: KeyUse,
): { id: string; key: Buffer } {
  return { id: ring.currentId, key: derive(currentMaster(ring), use) };
}

/** The key of this use under the master named `id`, if the ring holds it. */
export function keyOf(
  ring: KeyRing,
  id: string,
  use: KeyUse,
): Buffer | undefined {
  const master = ring.masters.get(id);
  return master ? derive(master, use) : undefined;
}

/**
 * The master keys themselves, the current one first: what was sealed or
 * signed before keys had identifiers used them as they were. Only for
 * reading such a value; nothing new is written with one.
 */
export function mastersBeforeIds(ring: KeyRing): Buffer[] {
  const current = currentMaster(ring);
  return [
    current,
    ...[...ring.masters.values()].filter((master) => master !== current),
  ];
}

/** Signs with the current key of this use. */
export function sign(ring: KeyRing, use: KeyUse, text: string): Buffer {
  return createHmac("sha256", currentKey(ring, use).key).update(text).digest();
}

/**
 * Every signature a key of the ring gives this text, the current one
 * first: the use's key under each master, then each master as it was used
 * before keys had identifiers. A value signed before a key change, or
 * before this release, is still recognised.
 */
export function signatures(ring: KeyRing, use: KeyUse, text: string): Buffer[] {
  const masters = mastersBeforeIds(ring);
  return [...masters.map((master) => derive(master, use)), ...masters].map(
    (key) => createHmac("sha256", key).update(text).digest(),
  );
}

/** Whether a key of the ring signed this text, in constant time per key. */
export function verify(
  ring: KeyRing,
  use: KeyUse,
  text: string,
  given: Buffer,
): boolean {
  let found = false;
  for (const expected of signatures(ring, use, text)) {
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      found = true;
    }
  }
  return found;
}
