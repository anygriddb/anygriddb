import { describe, expect, it } from "vitest";
import {
  createAutomationInputSchema,
  MAX_AUTOMATION_ACTIONS,
  nextScheduleRun,
  renderTemplate,
  templateKeys,
  webhookTemplateValues,
} from "./automation";

const TABLE = "11111111-1111-4111-8111-111111111111";

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
