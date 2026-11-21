import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mailFrom,
  sendMail,
  signedText,
  smtpRefusal,
  verifySmtp,
} from "./mail.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";

const NOBODY = { sender: null, signature: null };

describe("mailFrom", () => {
  it("leaves the address alone without a sender name", () => {
    expect(mailFrom("no-reply@example.org", NOBODY)).toBe(
      "no-reply@example.org",
    );
  });

  it("puts the sender name before the address", () => {
    expect(
      mailFrom("no-reply@example.org", { sender: "Registre", signature: null }),
    ).toEqual({ name: "Registre", address: "no-reply@example.org" });
  });

  it("replaces a name the address already carried", () => {
    expect(
      mailFrom("Old name <no-reply@example.org>", {
        sender: "Registre",
        signature: null,
      }),
    ).toEqual({ name: "Registre", address: "no-reply@example.org" });
  });
});

describe("signedText", () => {
  it("closes the text with the signature, after its mark", () => {
    expect(
      signedText("Hello.\n", { sender: null, signature: "The data team" }),
    ).toBe("Hello.\n\n-- \nThe data team");
  });

  it("adds nothing without a signature", () => {
    expect(signedText("Hello.\n", NOBODY)).toBe("Hello.\n");
  });
});

describe("sendMail", () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const config = () => ({
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: smtp.port,
    SMTP_FROM: "no-reply@example.org",
  });

  beforeAll(async () => {
    smtp = await fakeSmtp();
  });
  afterAll(() => smtp.close());

  it("sends under the instance's name, signed", async () => {
    await sendMail(
      config(),
      { sender: "Registre des essais", signature: "L’équipe données" },
      { to: "ada@example.org", subject: "Test", text: "Bonjour." },
    );
    const mail = await smtp.next("ada@example.org");
    const text = mailText(mail);
    expect(text).toMatch(/^From: Registre des essais <no-reply@example\.org>/m);
    expect(text).toContain("Bonjour.\r\n\r\n-- \r\nL’équipe données");
    // The envelope keeps the bare address.
    expect(mail.from).toContain("<no-reply@example.org>");
  });

  it("keeps a name with header characters inside the name", async () => {
    await sendMail(
      config(),
      { sender: 'Acme, "Data" <team>', signature: null },
      { to: "grace@example.org", subject: "Test", text: "Hello." },
    );
    const mail = await smtp.next("grace@example.org");
    const from = /^From: (.*)$/m.exec(mail.data)?.[1] ?? "";
    // One address in the header: the one mail is sent from.
    expect(from.match(/@/g)).toHaveLength(1);
    expect(from).toMatch(/<no-reply@example\.org>\s*$/);
    expect(mail.from).toContain("<no-reply@example.org>");
  });

  it("sends the bare address and the text as written with no voice", async () => {
    await sendMail(config(), NOBODY, {
      to: "linus@example.org",
      subject: "Test",
      text: "Hello.",
    });
    const text = mailText(await smtp.next("linus@example.org"));
    expect(text).toMatch(/^From: no-reply@example\.org/m);
    expect(text).not.toContain("-- ");
  });
});

// What a mail server's refusal is called. The shapes are the mail
// library's own, read off real refusals: a port nothing listens on, a
// name that does not resolve, a server with no STARTTLS, one whose
// certificate is not trusted, a port that speaks no TLS, a wrong password.
describe("smtpRefusal", () => {
  const refusal = (fields: Record<string, unknown>) =>
    Object.assign(new Error("refused"), fields);

  it("says that nothing answers", () => {
    expect(smtpRefusal(refusal({ code: "ESOCKET", syscall: "connect" }))).toBe(
      "smtp_unreachable",
    );
    expect(smtpRefusal(refusal({ code: "EDNS" }))).toBe("smtp_unreachable");
    expect(smtpRefusal(refusal({ code: "ETIMEDOUT" }))).toBe(
      "smtp_unreachable",
    );
    expect(smtpRefusal(refusal({ code: "ECONNECTION" }))).toBe(
      "smtp_unreachable",
    );
  });

  it("says that the connection is not one it can encrypt and verify", () => {
    // No STARTTLS where it is asked for.
    expect(smtpRefusal(refusal({ code: "ETLS", command: "STARTTLS" }))).toBe(
      "smtp_tls",
    );
    // A certificate that is not trusted, or a port that speaks no TLS:
    // the socket fails with nothing of the system in it.
    expect(smtpRefusal(refusal({ code: "ESOCKET" }))).toBe("smtp_tls");
  });

  it("says that the account is refused", () => {
    expect(smtpRefusal(refusal({ code: "EAUTH" }))).toBe("smtp_account");
  });

  it("keeps the general word for what it does not know", () => {
    expect(smtpRefusal(refusal({ code: "EENVELOPE" }))).toBe("invalid_smtp");
    expect(smtpRefusal("not an error")).toBe("invalid_smtp");
  });
});

describe("verifySmtp", () => {
  it("names a port nothing listens on", async () => {
    await expect(
      verifySmtp({
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: 9,
        SMTP_FROM: "grid@example.org",
      }),
    ).rejects.toMatchObject({ code: "smtp_unreachable" });
  });
});
