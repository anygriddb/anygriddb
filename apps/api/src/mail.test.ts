import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailFrom, sendMail, signedText } from "./mail.js";
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
