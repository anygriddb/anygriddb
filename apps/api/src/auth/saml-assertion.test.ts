import { describe, expect, it } from "vitest";
import {
  oidcAnnouncesOneFactor,
  samlAnnouncesOneFactor,
  samlRecipientHolds,
  samlSessionEnd,
} from "./saml-assertion.js";

const ACS = "https://grid.example.org/auth/saml/acs";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const NOW = new Date("2026-11-22T12:00:00Z");
const LATER = "2026-11-22T12:05:00Z";
const EARLIER = "2026-11-22T11:55:00Z";

const confirmation = (attributes: Record<string, string>, method = BEARER) => ({
  $: { Method: method },
  SubjectConfirmationData: [{ $: attributes }],
});
const withConfirmations = (...list: unknown[]) => ({
  Assertion: { Subject: [{ SubjectConfirmation: list }] },
});

describe("samlRecipientHolds", () => {
  it("takes the address of this service, however it is written", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation({ Recipient: ACS, NotOnOrAfter: LATER }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(true);
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation({
            Recipient: "https://GRID.example.org:443/auth/saml/acs",
            NotOnOrAfter: LATER,
          }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses an assertion meant for another service", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation({
            Recipient: "https://other.example.org/acs",
            NotOnOrAfter: LATER,
          }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(false);
  });

  it("does not count a confirmation that has expired", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation({ Recipient: ACS, NotOnOrAfter: EARLIER }),
          confirmation({
            Recipient: "https://other.example.org/acs",
            NotOnOrAfter: LATER,
          }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(false);
  });

  it("does not count another method than bearer", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation(
            { Recipient: ACS, NotOnOrAfter: LATER },
            "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key",
          ),
          confirmation({
            Recipient: "https://other.example.org/acs",
            NotOnOrAfter: LATER,
          }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps working with a provider that names no recipient", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(confirmation({ NotOnOrAfter: LATER })),
        ACS,
        NOW,
      ),
    ).toBe(true);
  });

  it("refuses an assertion no bearer confirmation vouches for", () => {
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation(
            { Recipient: ACS, NotOnOrAfter: LATER },
            "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key",
          ),
        ),
        ACS,
        NOW,
      ),
    ).toBe(false);
    expect(
      samlRecipientHolds(
        withConfirmations(
          confirmation({ Recipient: ACS, NotOnOrAfter: EARLIER }),
        ),
        ACS,
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses what is not an assertion", () => {
    expect(samlRecipientHolds(undefined, ACS, NOW)).toBe(false);
    expect(samlRecipientHolds({ Assertion: {} }, ACS, NOW)).toBe(false);
  });
});

describe("samlSessionEnd", () => {
  const statements = (...ends: Array<string | undefined>) => ({
    Assertion: {
      AuthnStatement: ends.map((end) => ({
        $: end ? { SessionNotOnOrAfter: end } : {},
      })),
    },
  });

  it("reads the earliest end the provider sets", () => {
    expect(samlSessionEnd(statements(LATER, EARLIER, undefined))).toEqual(
      new Date(EARLIER),
    );
  });

  it("has none when the provider sets none", () => {
    expect(samlSessionEnd(statements(undefined))).toBeNull();
    expect(samlSessionEnd({ Assertion: {} })).toBeNull();
  });

  it("refuses an end it cannot read", () => {
    expect(() => samlSessionEnd(statements("tomorrow"))).toThrow();
  });
});

describe("what a provider says of the factors it asked", () => {
  it("reads one factor in an OIDC token", () => {
    expect(oidcAnnouncesOneFactor({ amr: ["pwd"] })).toBe(true);
    expect(oidcAnnouncesOneFactor({ acr: "1" })).toBe(true);
    expect(oidcAnnouncesOneFactor({ acr: "0" })).toBe(true);
    expect(oidcAnnouncesOneFactor({ acr: "urn:example:loa:1fa:pwd" })).toBe(
      true,
    );
  });

  it("reads several, and lets the methods speak before the level", () => {
    expect(oidcAnnouncesOneFactor({ amr: ["pwd", "otp"] })).toBe(false);
    expect(oidcAnnouncesOneFactor({ amr: ["mfa"] })).toBe(false);
    expect(oidcAnnouncesOneFactor({ amr: ["pwd", "otp"], acr: "1" })).toBe(
      false,
    );
    expect(oidcAnnouncesOneFactor({ acr: "2" })).toBe(false);
  });

  it("takes a token that says nothing as saying nothing", () => {
    expect(oidcAnnouncesOneFactor({})).toBe(false);
    expect(oidcAnnouncesOneFactor({ amr: [] })).toBe(false);
    expect(oidcAnnouncesOneFactor({ amr: "pwd" })).toBe(false);
  });

  const classRef = (value: unknown) => ({
    Assertion: {
      AuthnStatement: [{ AuthnContext: [{ AuthnContextClassRef: [value] }] }],
    },
  });

  it("reads a password in a SAML assertion", () => {
    expect(
      samlAnnouncesOneFactor(
        classRef("urn:oasis:names:tc:SAML:2.0:ac:classes:Password"),
      ),
    ).toBe(true);
    expect(
      samlAnnouncesOneFactor(
        classRef({
          _: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
        }),
      ),
    ).toBe(true);
  });

  it("does not read one factor in another class, or in none", () => {
    expect(
      samlAnnouncesOneFactor(
        classRef("urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken"),
      ),
    ).toBe(false);
    expect(
      samlAnnouncesOneFactor(
        classRef("urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified"),
      ),
    ).toBe(false);
    expect(samlAnnouncesOneFactor({ Assertion: {} })).toBe(false);
  });
});
