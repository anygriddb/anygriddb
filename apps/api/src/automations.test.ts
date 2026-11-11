import { AppError, type EngineCatalog } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import type { Database } from "@anygriddb/db";
import { saveAutomation, stepError, templateValues } from "./automations.js";

const engine = {
  table: {
    columns: [
      { id: "1", name: "nom", label: "Nom", fieldType: "text", config: {} },
      { id: "2", name: "resp", label: "Resp", fieldType: "user", config: {} },
      {
        id: "3",
        name: "client",
        label: "Client",
        fieldType: "relation_one_to_many",
        config: {},
      },
      {
        id: "4",
        name: "tags",
        label: "Tags",
        fieldType: "multi_select",
        config: {},
      },
    ],
  },
} as unknown as EngineCatalog;

describe("templateValues", () => {
  it("gives every column as display text plus the run keys", () => {
    const values = templateValues(
      engine,
      {
        id: "r1",
        nom: "Acme",
        resp: ["u1", "u9"],
        client: [{ id: "c1", label: "Boréal" }],
        tags: ["a", "b"],
      },
      new Map([["u1", "Ada"]]),
      { table: "Clients", recordUrl: "https://app.example/b/x/t/y?row=r1" },
    );
    expect(values).toMatchObject({
      nom: "Acme",
      resp: "Ada, ",
      client: "Boréal",
      tags: "a, b",
      record_id: "r1",
      record_url: "https://app.example/b/x/t/y?row=r1",
      table: "Clients",
    });
    expect(values.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves row keys empty without a row", () => {
    const values = templateValues(engine, null, new Map(), {
      table: "T",
      recordUrl: "u",
    });
    expect(values.record_id).toBe("");
    expect(values.record_url).toBe("");
    expect(values.nom).toBeUndefined();
  });
});

describe("automation step errors", () => {
  it("keeps a public error's words, which the app translates", () => {
    expect(
      stepError(new AppError("source_value_duplicate", "orders_label_key")),
    ).toBe("Value already used in the source: orders_label_key");
    expect(stepError(new AppError("row_locked"))).toBe("Row locked");
    expect(stepError(new Error("socket hang up"))).toBe("Network error");
  });
});

describe("saveAutomation", () => {
  // The check comes before anything is read or written: no database.
  const save = (actions: unknown) =>
    saveAutomation({} as Database, {
      tableId: "00000000-0000-4000-8000-000000000001",
      createdBy: "00000000-0000-4000-8000-000000000002",
      name: "Notify",
      enabled: true,
      trigger: { type: "row_created" },
      actions: actions as never,
    });
  const hook = { type: "call_webhook", url: "https://127.0.0.1/hook" };

  it("refuses a webhook to a private address, wherever the action sits", async () => {
    for (const actions of [
      [hook],
      [{ type: "branch", then: [hook] }],
      [{ type: "branch", then: [], otherwise: [hook] }],
      [{ type: "for_each", actions: [hook] }],
      [{ type: "call_webhook", url: "http://example.org/hook" }],
    ]) {
      await expect(save(actions)).rejects.toMatchObject({
        code: "invalid_webhook",
      });
    }
  });
});
