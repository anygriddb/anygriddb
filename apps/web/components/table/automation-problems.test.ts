import type { AutomationAction } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  automationProblems,
  isPostAddress,
  partControl,
  problemKey,
} from "./automation-problems";

const TABLE = "01a20eab-d2d2-7a3f-8569-9dc74a139929";
const PERSON = "01a20eab-d23a-7cd5-994b-c3de30a07eb7";

describe("automationProblems", () => {
  it("finds nothing in an automation the server can keep", () => {
    const actions: AutomationAction[] = [
      { type: "update_record", values: { status: "Done" } },
      { type: "delete_record" },
      { type: "create_record", tableId: TABLE, values: {} },
      {
        type: "send_email",
        to: "{{email}}",
        subject: "New row",
        body: "",
      },
      { type: "call_webhook", url: " https://hooks.example.org/in " },
      {
        type: "send_slack",
        url: "https://hooks.example.org/s",
        message: "Hi",
      },
      { type: "notify", users: [PERSON], message: "Seen" },
      { type: "run_script", code: "return {};" },
    ];
    expect(automationProblems({ name: "Done", actions }, true)).toEqual([]);
  });

  it("names each missing part where the editor shows it, nested steps included", () => {
    const actions: AutomationAction[] = [
      { type: "update_record", values: {} },
      { type: "send_email", to: " ", subject: "", body: "" },
      {
        type: "branch",
        when: { conjunction: "and", conditions: [] },
        then: [{ type: "call_webhook", url: "https://" }], // NOSONAR: a stored JSON key holding steps, never a function
        otherwise: [{ type: "send_teams", url: "https://x", message: "" }],
      },
      {
        type: "for_each",
        tableId: TABLE,
        limit: 10,
        actions: [{ type: "notify", users: [], message: " " }],
      },
      { type: "run_script", code: "return {};" },
    ];
    expect(automationProblems({ name: "  ", actions }, false)).toEqual([
      { at: "", part: "name" },
      { at: "a0", part: "values" },
      { at: "a1", part: "to" },
      { at: "a1", part: "subject" },
      { at: "a2", part: "condition" },
      { at: "a2.then0", part: "url" },
      { at: "a2.otherwise0", part: "message" },
      { at: "a3.each0", part: "users" },
      { at: "a3.each0", part: "message" },
      { at: "a4", part: "code" },
    ]);
  });
});

describe("an automation's conditions", () => {
  const region = (value: string) => ({
    conjunction: "and" as const,
    conditions: [{ column: "region", op: "is" as const, value }],
  });
  const update: AutomationAction = {
    type: "update_record",
    values: { status: "Done" },
  };

  it("takes a condition with its value, and a loop over every row", () => {
    const actions: AutomationAction[] = [
      { type: "branch", when: region("North"), then: [update] }, // NOSONAR: a stored JSON key holding steps, never a function
      { type: "for_each", tableId: TABLE, limit: 5, actions: [update] },
      {
        type: "for_each",
        tableId: TABLE,
        limit: 5,
        filter: region("South"),
        actions: [update],
      },
    ];
    const trigger = { type: "enters_filter" as const, filter: region("East") };
    expect(automationProblems({ name: "Due", trigger, actions }, true)).toEqual(
      [],
    );
  });

  it("names a condition left without its value, which would let every row through", () => {
    const actions: AutomationAction[] = [
      { type: "branch", when: region(""), then: [update] }, // NOSONAR: a stored JSON key holding steps, never a function
      {
        type: "for_each",
        tableId: TABLE,
        limit: 5,
        filter: { conjunction: "or", conditions: [] },
        actions: [update],
      },
    ];
    const trigger = {
      type: "enters_filter" as const,
      filter: { conjunction: "and" as const, conditions: [] },
    };
    expect(automationProblems({ name: "Due", trigger, actions }, true)).toEqual(
      [
        { at: "t", part: "condition" },
        { at: "a0", part: "condition" },
        { at: "a1", part: "condition" },
      ],
    );
  });
});

describe("the secrets of an automation's scripts", () => {
  it("takes a name, a host and a value, or a value already kept", () => {
    expect(
      automationProblems(
        {
          name: "Sync",
          actions: [{ type: "run_script", code: "return {};" }],
          secrets: [
            {
              name: "API_TOKEN",
              host: "api.example.org",
              value: "s",
              kept: false,
            },
            { name: "OTHER", host: "Hooks.Example.org", value: "", kept: true },
          ],
        },
        true,
      ),
    ).toEqual([]);
  });

  it("names a part the server would refuse, a name given twice included", () => {
    expect(
      automationProblems(
        {
          name: "Sync",
          actions: [{ type: "run_script", code: "return {};" }],
          secrets: [
            {
              name: "1TOKEN",
              host: "api.example.org",
              value: "s",
              kept: false,
            },
            {
              name: "TOKEN",
              host: "https://api.example.org/",
              value: "",
              kept: false,
            },
            { name: "TOKEN", host: "api.example.org", value: "s", kept: false },
          ],
        },
        true,
      ),
    ).toEqual([
      { at: "s0", part: "secretName" },
      { at: "s1", part: "secretHost" },
      { at: "s1", part: "secretValue" },
      { at: "s2", part: "secretName" },
    ]);
  });
});

describe("isPostAddress", () => {
  it("takes an HTTPS address with a host", () => {
    expect(isPostAddress("https://hooks.example.org/a?b=1")).toBe(true);
  });

  it("refuses what the server could not read or would not post to", () => {
    for (const url of [
      "",
      "https://",
      "https:// space.example.org",
      "http://example.org",
      "example.org",
      "ftp://example.org",
    ]) {
      expect(isPostAddress(url), url).toBe(false);
    }
  });
});

describe("the ids of a part", () => {
  it("are one per place, and the name's has none", () => {
    expect(problemKey("", "name")).toBe("name");
    expect(problemKey("a2.then0", "url")).toBe("a2.then0:url");
    expect(partControl("", "name")).toBe("automation-name");
    expect(partControl("a2.then0", "url")).toBe("automation-a2-then0-url");
  });
});
