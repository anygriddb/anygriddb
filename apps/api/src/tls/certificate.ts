/**
 * X.509 certificates for AnyGridDB's own authority (ADR 0029): an
 * authority for the instance, and the server certificate it signs. Keys
 * are ECDSA P-256 and signatures SHA-256, from `node:crypto`; this module
 * only writes the DER structures of RFC 5280 around them, and Node's own
 * X.509 parser reads every certificate back in the tests.
 *
 * The authority is name-constrained: it can only vouch for the names and
 * addresses it was made for, so a workstation that trusts it trusts it for
 * AnyGridDB alone, never for another site.
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octets = (value: Buffer) => tlv(0x04, value);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));
const explicit = (tag: number, value: Buffer) => tlv(0xa0 + tag, value);

/** A non-negative INTEGER from big-endian bytes. */
function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const padded =
    (trimmed[0] ?? 0) & 0x80
      ? Buffer.concat([Buffer.from([0]), trimmed])
      : trimmed;
  return tlv(0x02, padded);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups: number[] = [part & 0x7f];
    for (
      let value = Math.floor(part / 128);
      value > 0;
      value = Math.floor(value / 128)
    ) {
      groups.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A BIT STRING of named bits (key usage), trailing zero bits dropped. */
function namedBits(bits: readonly number[]): Buffer {
  const width = Math.max(...bits) + 1;
  const bytes = Buffer.alloc(Math.ceil(width / 8));
  for (const bit of bits) {
    const index = Math.floor(bit / 8);
    bytes[index] = (bytes[index] ?? 0) | (0x80 >> (bit % 8));
  }
  return tlv(0x03, Buffer.from([bytes.length * 8 - width]), bytes);
}

function bitString(value: Buffer): Buffer {
  return tlv(0x03, Buffer.from([0]), value);
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString();
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), "ascii"))
    : tlv(0x18, Buffer.from(digits, "ascii"));
}

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

function name(commonName: string): Buffer {
  return sequence(
    set(sequence(oid(OID.organization), utf8("AnyGridDB"))),
    set(sequence(oid(OID.commonName), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    octets(value),
  );
}

/** An IPv4 or IPv6 address as its bytes. */
function addressBytes(address: string): Buffer {
  if (isIP(address) === 4) {
    return Buffer.from(address.split(".").map(Number));
  }
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = groups(tail);
  const middle = address.includes("::")
    ? Array<string>(8 - left.length - right.length).fill("0")
    : [];
  const all = [...left, ...middle, ...right];
  const bytes = Buffer.alloc(16);
  all.forEach((group, index) =>
    bytes.writeUInt16BE(parseInt(group, 16), index * 2),
  );
  return bytes;
}

/** A name a certificate covers: a DNS name or an IP address. */
function generalName(value: string): Buffer {
  return isIP(value)
    ? tlv(0x87, addressBytes(value))
    : tlv(0x82, Buffer.from(value.toLowerCase(), "ascii"));
}

/** Permitted subtrees: each name and its subdomains, each address alone. */
function nameConstraints(names: readonly string[]): Buffer {
  const subtrees = names.map((value) => {
    if (!isIP(value)) return sequence(generalName(value));
    const bytes = addressBytes(value);
    return sequence(tlv(0x87, bytes, Buffer.alloc(bytes.length, 0xff)));
  });
  return sequence(explicit(0, Buffer.concat(subtrees)));
}

function spki(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}

/** The key's identifier: SHA-1 of its public key bits (RFC 5280, 4.2.1.2). */
function keyId(key: KeyObject): Buffer {
  const der = spki(key);
  // The last element of SubjectPublicKeyInfo is the key's BIT STRING; for
  // P-256 the point is its last 65 bytes.
  return createHash("sha1")
    .update(der.subarray(der.length - 65))
    .digest();
}

function pem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export type Issued = {
  /** PEM certificate. */
  cert: string;
  /** PEM private key, PKCS #8. */
  key: string;
};

function issue(input: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signer: KeyObject;
  notAfter: Date;
  extensions: Buffer[];
}): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name(input.issuer),
    // An hour back: a client whose clock is a little behind still accepts it.
    sequence(time(new Date(Date.now() - 3_600_000)), time(input.notAfter)),
    name(input.subject),
    spki(input.publicKey),
    explicit(3, sequence(...input.extensions)),
  );
  const signature = sign("sha256", tbs, input.signer);
  return pem(sequence(tbs, algorithm, bitString(signature)));
}

function keyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

/**
 * The instance's authority, for ten years, limited to `names` and the
 * certificates it signs directly.
 */
export function issueAuthority(input: {
  commonName: string;
  names: readonly string[];
  years?: number;
}): Issued {
  const { privateKey, publicKey } = keyPair();
  const notAfter = new Date();
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (input.years ?? 10));
  const cert = issue({
    subject: input.commonName,
    issuer: input.commonName,
    publicKey,
    signer: privateKey,
    notAfter,
    extensions: [
      extension(
        OID.basicConstraints,
        true,
        sequence(tlv(0x01, Buffer.from([0xff])), integer(Buffer.from([0]))),
      ),
      // keyCertSign, cRLSign.
      extension(OID.keyUsage, true, namedBits([5, 6])),
      extension(OID.subjectKeyIdentifier, false, octets(keyId(publicKey))),
      extension(OID.nameConstraints, true, nameConstraints(input.names)),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** A server certificate for `names`, signed by the authority. */
export function issueServer(input: {
  names: readonly string[];
  authority: {
    cert: string;
    key: KeyObject;
    publicKey: KeyObject;
    commonName: string;
  };
  days?: number;
}): Issued {
  const { privateKey, publicKey } = keyPair();
  const notAfter = new Date(Date.now() + (input.days ?? 397) * 86_400_000);
  const [first = "localhost"] = input.names;
  const cert = issue({
    subject: first,
    issuer: input.authority.commonName,
    publicKey,
    signer: input.authority.key,
    notAfter,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature.
      extension(OID.keyUsage, true, namedBits([0])),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(
        OID.subjectAltName,
        false,
        sequence(...input.names.map(generalName)),
      ),
      extension(OID.subjectKeyIdentifier, false, octets(keyId(publicKey))),
      extension(
        OID.authorityKeyIdentifier,
        false,
        sequence(tlv(0x80, keyId(input.authority.publicKey))),
      ),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/**
 * A self-signed client certificate, for a TLS library that takes a key
 * with the authorities it trusts (Oracle's thin driver): never sent unless
 * a server asks for one, and its key never leaves the process.
 */
export function issueClient(input: {
  commonName: string;
  days?: number;
}): Issued {
  const { privateKey, publicKey } = keyPair();
  const notAfter = new Date(Date.now() + (input.days ?? 397) * 86_400_000);
  const cert = issue({
    subject: input.commonName,
    issuer: input.commonName,
    publicKey,
    signer: privateKey,
    notAfter,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature.
      extension(OID.keyUsage, true, namedBits([0])),
      extension(OID.extKeyUsage, false, sequence(oid(OID.clientAuth))),
      extension(OID.subjectKeyIdentifier, false, octets(keyId(publicKey))),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
