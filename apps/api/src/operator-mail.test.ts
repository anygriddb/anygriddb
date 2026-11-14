import { describe, expect, it } from "vitest";
import { EN, FR } from "./mail.test-helpers.js";
import {
  MAX_OPERATOR_MAIL_RECIPIENTS,
  operatorMailInputSchema,
  operatorMailPayloadSchema,
} from "./operator-mail.js";
import { operatorMailFooter, operatorMailText } from "./mail-i18n.js";

describe("operatorMailInputSchema", () => {
  it("accepts a notice to every active account", () => {
    const parsed = operatorMailInputSchema.parse({
      subject: "Maintenance tonight",
      body: "The instance will pause for thirty minutes.",
      recipients: { mode: "all_active" },
    });
    expect(parsed.recipients.mode).toBe("all_active");
  });

  it("rejects a subject with a newline", () => {
    expect(() =>
      operatorMailInputSchema.parse({
        subject: "Line\nbreak",
        body: "Body",
        recipients: { mode: "all_active" },
      }),
    ).toThrow();
  });

  it("rejects more than the recipient cap", () => {
    const userIds = Array.from(
      { length: MAX_OPERATOR_MAIL_RECIPIENTS + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(() =>
      operatorMailInputSchema.parse({
        subject: "Hi",
        body: "There",
        recipients: { mode: "ids", userIds },
      }),
    ).toThrow();
  });
});

describe("operatorMailPayloadSchema", () => {
  it("keeps the frozen recipient list", () => {
    const parsed = operatorMailPayloadSchema.parse({
      actorId: "11111111-1111-4111-8111-111111111111",
      subject: "Notice",
      body: "Read this.",
      userIds: ["22222222-2222-4222-8222-222222222222"],
      locale: "en",
    });
    expect(parsed.userIds).toHaveLength(1);
  });
});

describe("operatorMailText", () => {
  it("appends the English administrator footer", () => {
    expect(operatorMailText(EN, "Please sign in once.")).toContain(
      operatorMailFooter(EN),
    );
    expect(operatorMailFooter(EN)).toMatch(/administrator/i);
  });

  it("appends the French administrator footer", () => {
    expect(operatorMailText(FR, "Merci de vous connecter.")).toContain(
      operatorMailFooter(FR),
    );
    expect(operatorMailFooter(FR)).toMatch(/administrateur/i);
  });
});
