/**
 * Two identity providers for integration tests: an OIDC one behind
 * openid-client's fetch hook, and a SAML one that signs real assertions.
 * Keys are made for each run; nothing here leaves the process.
 */
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  webcrypto,
} from "node:crypto";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey as JoseKey,
  type JWK,
} from "jose";

type Claims = Record<string, unknown>;

type SigningKey = { kid: string; privateKey: JoseKey; jwk: JWK };

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/**
 * Discovery, keys, and a token endpoint that signs what the test asks for,
 * with the published key unless the test says how to forge it.
 */
export async function oidcProvider(issuer: string, clientId: string) {
  const published = await signingKey("k1");
  const state = {
    claims: {} as Claims,
    nonce: "",
    keys: [published],
    /** Signs with this key instead of the published one. */
    signer: published,
    /** The name the header gives the key. */
    headerKid: "k1",
    /** Damages the signature's last byte. */
    flipSignature: false,
  };
  const idToken = async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ nonce: state.nonce, ...state.claims })
      .setProtectedHeader({ alg: "RS256", kid: state.headerKid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(
        typeof state.claims.sub === "string"
          ? state.claims.sub
          : `sub-${String(state.claims.email)}`,
      )
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(state.signer.privateKey);
    if (!state.flipSignature) return token;
    const [head, body, signature = ""] = token.split(".");
    const bytes = Buffer.from(signature, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return `${String(head)}.${String(body)}.${bytes.toString("base64url")}`;
  };
  const fetch = async (
    url: string,
    options: RequestInit,
  ): Promise<Response> => {
    const target = new URL(url);
    if (target.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (target.pathname === "/jwks") {
      return json({ keys: state.keys.map((key) => key.jwk) });
    }
    if (target.pathname === "/token" && options.method === "POST") {
      return json({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 300,
        id_token: await idToken(),
      });
    }
    return new Response("not found", { status: 404 });
  };
  /** A logout token as the provider would post it. */
  const logoutToken = async (
    claims: Claims,
    options: { key?: SigningKey; audience?: string } = {},
  ) => {
    const key = options.key ?? state.keys[0] ?? published;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} }, // NOSONAR: the name the specification gives this event, never fetched
      jti: randomUUID(),
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "logout+jwt" })
      .setIssuer(issuer)
      .setAudience(options.audience ?? clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(key.privateKey);
  };
  const reset = () => {
    state.keys = [published];
    state.signer = published;
    state.headerKid = published.kid;
    state.flipSignature = false;
  };
  return {
    fetch,
    state,
    logoutToken,
    reset,
    newKey: signingKey,
  };
}

const here = createRequire(import.meta.url);
const fromSaml = createRequire(here.resolve("@node-saml/node-saml"));
const fromPasskeys = createRequire(here.resolve("@simplewebauthn/server"));

type XmlSigner = {
  addReference: (input: {
    xpath: string;
    digestAlgorithm: string;
    transforms: string[];
  }) => void;
  computeSignature: (
    xml: string,
    options: { location: { reference: string; action: string } },
  ) => void;
  getSignedXml: () => string;
};
const { SignedXml } = fromSaml("xml-crypto") as {
  SignedXml: new (options: {
    privateKey: string;
    publicCert: string;
    signatureAlgorithm: string;
    canonicalizationAlgorithm: string;
  }) => XmlSigner;
};
fromPasskeys("reflect-metadata");
const x509 = fromPasskeys("@peculiar/x509") as {
  cryptoProvider: { set: (crypto: unknown) => void };
  X509CertificateGenerator: {
    createSelfSigned: (input: {
      serialNumber: string;
      name: string;
      notBefore: Date;
      notAfter: Date;
      signingAlgorithm: { name: string; hash: string };
      keys: webcrypto.CryptoKeyPair;
    }) => Promise<{ toString: (format: "pem") => string }>;
  };
};

/** A signing identity: an RSA key and its self-signed certificate. */
export async function samlIdentity(
  validity: { from?: Date; until?: Date } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  x509.cryptoProvider.set(webcrypto);
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const keys = {
    privateKey: await webcrypto.subtle.importKey(
      "pkcs8",
      privateKey.export({ type: "pkcs8", format: "der" }),
      algorithm,
      true,
      ["sign"],
    ),
    publicKey: await webcrypto.subtle.importKey(
      "spki",
      publicKey.export({ type: "spki", format: "der" }),
      algorithm,
      true,
      ["verify"],
    ),
  };
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString("hex"),
    name: "CN=Test provider",
    notBefore: validity.from ?? new Date(Date.now() - 3_600_000),
    notAfter: validity.until ?? new Date(Date.now() + 86_400_000),
    signingAlgorithm: algorithm,
    keys,
  });
  return {
    cert: certificate.toString("pem"),
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export type SamlIdentity = Awaited<ReturnType<typeof samlIdentity>>;

const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

export type AssertionInput = {
  identity: SamlIdentity;
  issuer: string;
  audience: string;
  acs: string;
  inResponseTo: string;
  nameId: string;
  nameIdFormat?: string;
  email?: string;
  /** `null` leaves the attribute out; a value replaces the ACS. */
  recipient?: string | null;
  sessionNotOnOrAfter?: Date;
  classRef?: string;
};

/** A base64 SAML response whose assertion is signed by the identity. */
export function samlResponse(input: AssertionInput): string {
  const now = new Date();
  const later = new Date(now.getTime() + 300_000).toISOString();
  const instant = now.toISOString();
  const recipient =
    input.recipient === null
      ? ""
      : ` Recipient="${input.recipient ?? input.acs}"`;
  const sessionEnd = input.sessionNotOnOrAfter
    ? ` SessionNotOnOrAfter="${input.sessionNotOnOrAfter.toISOString()}"`
    : "";
  const attribute = input.email
    ? `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${input.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    : "";
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${randomUUID()}" IssueInstant="${instant}" Version="2.0">` +
    `<saml:Issuer>${input.issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${input.nameIdFormat ?? PERSISTENT}">${input.nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${input.inResponseTo}" NotOnOrAfter="${later}"${recipient}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="_s1"${sessionEnd}><saml:AuthnContext><saml:AuthnContextClassRef>${input.classRef ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified"}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    attribute +
    `</saml:Assertion>`;
  const signedAssertion = signed(
    input.identity,
    assertion,
    "Assertion",
    "//*[local-name(.)='Issuer']",
  );
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomUUID()}" InResponseTo="${input.inResponseTo}" IssueInstant="${instant}" Version="2.0">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${input.issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertion +
    `</samlp:Response>`;
  return Buffer.from(
    signed(
      input.identity,
      response,
      "Response",
      "/*/*[local-name(.)='Issuer']",
    ),
  ).toString("base64");
}

/** The element signed where a provider signs it: right after its issuer. */
function signed(
  identity: SamlIdentity,
  xml: string,
  element: string,
  issuer: string,
): string {
  const signer = new SignedXml({
    privateKey: identity.key,
    publicCert: identity.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: `/*[local-name(.)='${element}']`,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  signer.computeSignature(xml, {
    location: { reference: issuer, action: "after" },
  });
  return signer.getSignedXml();
}

/** What the app asked the provider, read from its redirect. */
export function samlRequestOf(location: string): {
  id: string;
  relayState: string;
  forceAuthn: boolean;
} {
  const url = new URL(location);
  const xml = inflateRawSync(
    Buffer.from(url.searchParams.get("SAMLRequest") ?? "", "base64"),
  ).toString();
  const tag = xml.indexOf("<samlp:AuthnRequest");
  const opening = xml.slice(tag, xml.indexOf(">", tag));
  const idAt = opening.indexOf(' ID="') + 5;
  return {
    id: opening.slice(idAt, opening.indexOf('"', idAt)),
    relayState: url.searchParams.get("RelayState") ?? "",
    forceAuthn: opening.includes('ForceAuthn="true"'),
  };
}
