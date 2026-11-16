import { describe, expect, it } from "vitest";
import {
  createAutomationInputSchema,
  fillSecrets,
  hasScript,
  MAX_AUTOMATION_ACTIONS,
  MAX_SCRIPT_LENGTH,
  nextScheduleRun,
  renderTemplate,
  scriptTemplateValues,
  secretNames,
  templateKeys,
  webhookTemplateValues,
  writeSlackMessage,
  writeTeamsMessage,
} from "./automation";

const TABLE = "11111111-1111-4111-8111-111111111111";

describe("a message to Slack or Teams", () => {
  it("writes the body each service takes, cut to what it shows", () => {
    expect(JSON.parse(writeSlackMessage("Row ready"))).toEqual({
      text: "Row ready",
    });
    expect(
      (JSON.parse(writeSlackMessage("x".repeat(5_000))) as { text: string })
        .text,
    ).toHaveLength(3_000);
    type Card = {
      type: string;
      attachments: Array<{
        contentType: string;
        content: { type: string; body: Array<{ text: string }> };
      }>;
    };
    const titled = JSON.parse(writeTeamsMessage("Row ready", "Notice")) as Card;
    expect(titled.type).toBe("message");
    expect(titled.attachments[0]?.contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(titled.attachments[0]?.content.type).toBe("AdaptiveCard");
    expect(titled.attachments[0]?.content.body.map((b) => b.text)).toEqual([
      "Notice",
      "Row ready",
    ]);
    const plain = JSON.parse(writeTeamsMessage("Row ready", "  ")) as Card;
    expect(plain.attachments[0]?.content.body.map((b) => b.text)).toEqual([
      "Row ready",
    ]);
  });

  it("accepts send_slack and send_teams over https only", () => {
    const base = {
      tableId: TABLE,
      name: "Alert",
      trigger: { type: "row_created" as const },
    };
    expect(
      createAutomationInputSchema.safeParse({
        ...base,
        actions: [
          {
            type: "send_slack",
            url: "https://hooks.slack.com/services/T/B/x",
            message: "Hi {{name}}",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      createAutomationInputSchema.safeParse({
        ...base,
        actions: [
          {
            type: "send_teams",
            url: "https://example.webhook.office.com/webhookb2/x",
            message: "Hi",
            title: "Update",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      createAutomationInputSchema.safeParse({
        ...base,
        actions: [
          {
            type: "send_slack",
            url: "http://hooks.slack.com/services/T/B/x",
            message: "Hi",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      createAutomationInputSchema.safeParse({
        ...base,
        actions: [
          {
            type: "send_teams",
            url: "https://example.webhook.office.com/x",
            message: " ",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("substitutes known keys as plain text", () => {
    expect(
      renderTemplate("Bonjour {{ nom }}, total {{montant}} {{absent}}", {
        nom: "Ada",
        montant: "12",
      }),
    ).toBe("Bonjour Ada, total 12 ");
  });

  it("never evaluates code or reaches prototype keys", () => {
    expect(renderTemplate("{{constructor}}{{__proto__}}", {})).toBe("");
    expect(renderTemplate("{{ nom.toUpperCase() }}", { nom: "a" })).toBe(
      "{{ nom.toUpperCase() }}",
    );
    expect(templateKeys("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("createAutomationInputSchema", () => {
  it("accepts a row trigger with an update action", () => {
    expect(
      createAutomationInputSchema.safeParse({
        tableId: TABLE,
        name: "Clôture",
        trigger: { type: "row_updated", columns: ["statut"] },
        actions: [{ type: "update_record", values: { note: "Vu le {{now}}" } }],
      }).success,
    ).toBe(true);
  });

  it("refuses row actions on a schedule, plain http calls, and a week without day", () => {
    const schedule = {
      type: "schedule",
      every: "day",
      at: "08:00",
      timeZone: "Europe/Paris",
    };
    expect(
      createAutomationInputSchema.safeParse({
        tableId: TABLE,
        name: "x",
        trigger: schedule,
        actions: [{ type: "update_record", values: { a: "b" } }],
      }).success,
    ).toBe(false);
    expect(
      createAutomationInputSchema.safeParse({
        tableId: TABLE,
        name: "x",
        trigger: { type: "row_created" },
        actions: [{ type: "call_webhook", url: "http://example.com" }],
      }).success,
    ).toBe(false);
    expect(
      createAutomationInputSchema.safeParse({
        tableId: TABLE,
        name: "x",
        trigger: { ...schedule, every: "week" },
        actions: [{ type: "send_email", to: "a@b.c", subject: "s", body: "b" }],
      }).success,
    ).toBe(false);
  });
});

describe("branches, loops, and rowless triggers", () => {
  const parse = (trigger: unknown, actions: unknown[]) =>
    createAutomationInputSchema.safeParse({
      tableId: TABLE,
      name: "x",
      trigger,
      actions,
    }).success;
  const when = {
    conjunction: "and",
    conditions: [{ column: "statut", op: "is", value: "fait" }],
  };
  const update = { type: "update_record", values: { note: "vu" } };

  it("accepts a branch and a loop of plain actions", () => {
    expect(
      parse({ type: "row_created" }, [
        {
          type: "branch",
          when,
          then: [update],
          otherwise: [{ type: "delete_record" }],
        },
        {
          type: "for_each",
          tableId: TABLE,
          filter: when,
          limit: 5,
          actions: [update],
        },
      ]),
    ).toBe(true);
  });

  it("refuses an action inside a branch that holds others, and too many", () => {
    const branch = { type: "branch", when, then: [update] };
    expect(
      parse({ type: "row_created" }, [{ ...branch, then: [branch] }]),
    ).toBe(false);
    expect(
      parse({ type: "row_created" }, [
        { ...branch, then: Array(11).fill(update) },
      ]),
    ).toBe(false);
    expect(
      parse(
        { type: "row_created" },
        Array(MAX_AUTOMATION_ACTIONS).fill(update),
      ),
    ).toBe(true);
    expect(
      parse(
        { type: "row_created" },
        Array(MAX_AUTOMATION_ACTIONS + 1).fill(update),
      ),
    ).toBe(false);
    expect(
      parse({ type: "row_created" }, [
        { type: "for_each", tableId: TABLE, limit: 101, actions: [update] },
      ]),
    ).toBe(false);
  });

  it("keeps the trigger's row actions off triggers without one, but not a loop's", () => {
    for (const trigger of [{ type: "webhook" }, { type: "row_deleted" }]) {
      expect(parse(trigger, [update])).toBe(false);
      expect(parse(trigger, [{ type: "delete_record" }])).toBe(false);
      expect(parse(trigger, [{ type: "branch", when, then: [update] }])).toBe(
        false,
      );
      expect(
        parse(trigger, [
          { type: "for_each", tableId: TABLE, limit: 5, actions: [update] },
        ]),
      ).toBe(true);
    }
  });
});

describe("webhookTemplateValues", () => {
  it("gives the body's fields one level down, as text", () => {
    expect(
      webhookTemplateValues({
        who: "Ada",
        "order-ref": 42,
        paid: true,
        order: { id: 7, lines: [1, 2] },
        none: null,
      }),
    ).toEqual({
      body: '{"who":"Ada","order-ref":42,"paid":true,"order":{"id":7,"lines":[1,2]},"none":null}',
      body_who: "Ada",
      body_order_ref: "42",
      body_paid: "true",
      body_order: '{"id":7,"lines":[1,2]}',
      body_order_id: "7",
      body_order_lines: "[1,2]",
      body_none: "",
    });
  });

  it("gives only `body` for a body that is not an object", () => {
    expect(webhookTemplateValues([1, 2])).toEqual({ body: "[1,2]" });
    expect(webhookTemplateValues(undefined)).toEqual({ body: "null" });
  });
});

describe("a script among an automation's actions", () => {
  const withActions = (actions: unknown[], trigger: unknown) =>
    createAutomationInputSchema.safeParse({
      tableId: TABLE,
      name: "Scripted",
      trigger,
      actions,
    });
  const script = { type: "run_script", code: "return 1;" };

  it("is accepted at the top, in a branch, in a loop, and without a row", () => {
    const parsed = withActions(
      [
        script,
        {
          type: "branch",
          when: { conjunction: "and", conditions: [] },
          then: [script],
        },
        { type: "for_each", tableId: TABLE, actions: [script] },
      ],
      { type: "row_created" },
    );
    expect(parsed.success).toBe(true);
    expect(withActions([script], { type: "webhook" }).success).toBe(true);
    if (parsed.success) expect(hasScript(parsed.data.actions)).toBe(true);
  });

  it("is refused empty, too long, or with a field it does not have", () => {
    const row = { type: "row_created" };
    expect(withActions([{ ...script, code: "" }], row).success).toBe(false);
    expect(
      withActions([{ ...script, code: "x".repeat(MAX_SCRIPT_LENGTH + 1) }], row)
        .success,
    ).toBe(false);
    expect(
      withActions([{ ...script, url: "https://x.test" }], row).success,
    ).toBe(false);
  });

  it("is found wherever it is, and not where there is none", () => {
    expect(hasScript([{ type: "delete_record" }])).toBe(false);
    expect(
      hasScript([
        {
          type: "branch",
          when: { conjunction: "and", conditions: [] },
          then: [{ type: "delete_record" }],
          otherwise: [{ type: "run_script", code: "1" }],
        },
      ]),
    ).toBe(true);
    expect(
      hasScript([
        {
          type: "for_each",
          tableId: TABLE,
          limit: 1,
          actions: [{ type: "run_script", code: "1" }],
        },
      ]),
    ).toBe(true);
  });
});

describe("scriptTemplateValues", () => {
  it("gives an object's keys as text, under script_", () => {
    expect(
      scriptTemplateValues({
        total: 42,
        ok: true,
        name: "Ada",
        none: null,
        list: [1, 2],
        "odd key!": "x",
      }),
    ).toEqual({
      script_total: "42",
      script_ok: "true",
      script_name: "Ada",
      script_none: "",
      script_list: "[1,2]",
      script_odd_key_: "x",
    });
  });

  it("gives anything else as script_result, and nothing for nothing", () => {
    expect(scriptTemplateValues("done")).toEqual({ script_result: "done" });
    expect(scriptTemplateValues([1, 2])).toEqual({ script_result: "[1,2]" });
    expect(scriptTemplateValues(null)).toEqual({});
    expect(scriptTemplateValues(undefined)).toEqual({});
  });

  it("keeps a bounded number of keys, each of a bounded length", () => {
    const many = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`k${String(index)}`, "v"]),
    );
    expect(Object.keys(scriptTemplateValues(many))).toHaveLength(50);
    const values = scriptTemplateValues({
      ["k".repeat(100)]: "x".repeat(5_000),
    });
    const [key] = Object.keys(values);
    expect(key).toHaveLength(63);
    expect(values[key ?? ""]).toHaveLength(4_000);
  });
});

describe("the secrets an automation keeps for its scripts", () => {
  const withSecrets = (secrets: unknown) =>
    createAutomationInputSchema.safeParse({
      tableId: TABLE,
      name: "Calls",
      trigger: { type: "row_created" },
      actions: [{ type: "run_script", code: "return 1;" }],
      secrets,
    });

  it("takes a name, a host in lower case, and a value or none", () => {
    const parsed = withSecrets([
      { name: "API_TOKEN", host: "API.Example.org", value: "s3cr3t" },
      { name: "kept", host: "hooks.example.net" },
    ]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.secrets).toEqual([
        { name: "API_TOKEN", host: "api.example.org", value: "s3cr3t" },
        { name: "kept", host: "hooks.example.net" },
      ]);
    }
    expect(withSecrets(undefined).success).toBe(true);
  });

  it("refuses a name a script could not write, a host that is not one, and a name twice", () => {
    const secret = { name: "TOKEN", host: "api.example.org", value: "x" };
    for (const wrong of [
      [{ ...secret, name: "1TOKEN" }],
      [{ ...secret, name: "to ken" }],
      [{ ...secret, name: "" }],
      [{ ...secret, host: "https://api.example.org" }],
      [{ ...secret, host: "api.example.org/path" }],
      [{ ...secret, host: "api.example.org:8443" }],
      [{ ...secret, host: "localhost" }],
      [{ ...secret, host: "10.0.0.1" }],
      [{ ...secret, host: "*.example.org" }],
      [{ ...secret, value: "" }],
      [{ ...secret, other: true }],
      [secret, { ...secret, value: "y" }],
      Array.from({ length: 11 }, (_, index) => ({
        ...secret,
        name: `T${String(index)}`,
      })),
    ]) {
      expect(withSecrets(wrong).success).toBe(false);
    }
  });

  it("finds the names a text writes, and fills them or says which is missing", () => {
    const text =
      "Bearer {{secret.TOKEN}} and {{ secret.KEY_2 }}, not {{TOKEN}}";
    expect(secretNames(text)).toEqual(["TOKEN", "KEY_2"]);
    expect(
      fillSecrets(
        text,
        new Map([
          ["TOKEN", "a"],
          ["KEY_2", "b"],
        ]),
      ),
    ).toEqual({ text: "Bearer a and b, not {{TOKEN}}" });
    expect(fillSecrets(text, new Map([["TOKEN", "a"]]))).toEqual({
      missing: "KEY_2",
    });
    // A value is put in as it is: what it holds is not read again.
    expect(
      fillSecrets("{{secret.A}}", new Map([["A", "{{secret.B}} $& $1"]])),
    ).toEqual({ text: "{{secret.B}} $& $1" });
  });
});

describe("nextScheduleRun", () => {
  const paris = {
    type: "schedule" as const,
    at: "09:30",
    timeZone: "Europe/Paris",
  };

  it("runs daily at the wall-clock time of the zone", () => {
    // 2026-11-07 is in winter time: Paris is UTC+1.
    expect(
      nextScheduleRun(
        { ...paris, every: "day" },
        new Date("2026-11-07T07:00:00Z"),
      ).toISOString(),
    ).toBe("2026-11-07T08:30:00.000Z");
    expect(
      nextScheduleRun(
        { ...paris, every: "day" },
        new Date("2026-11-07T08:30:00Z"),
      ).toISOString(),
    ).toBe("2026-11-08T08:30:00.000Z");
  });

  it("follows daylight saving time", () => {
    // Summer time ends on 2026-10-25 in Paris.
    expect(
      nextScheduleRun(
        { ...paris, every: "day" },
        new Date("2026-10-24T12:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-25T08:30:00.000Z");
    expect(
      nextScheduleRun(
        { ...paris, every: "day" },
        new Date("2026-10-23T12:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-24T07:30:00.000Z");
  });

  it("runs weekly on the chosen day and hourly at the minute", () => {
    // 2026-11-07 is a Saturday; Monday is 1.
    expect(
      nextScheduleRun(
        { ...paris, every: "week", weekday: 1 },
        new Date("2026-11-07T07:00:00Z"),
      ).toISOString(),
    ).toBe("2026-11-09T08:30:00.000Z");
    expect(
      nextScheduleRun(
        { ...paris, every: "hour" },
        new Date("2026-11-07T07:45:00Z"),
      ).toISOString(),
    ).toBe("2026-11-07T08:30:00.000Z");
  });
});
