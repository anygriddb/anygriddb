/**
 * A field's rules on its values (ADR 0141), through the real router on a
 * migrated database: a number's bounds and a short text's length and mask
 * refuse a write that misses them, saying the rule, and take one that
 * fits; a field's settings are held to them too.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

/** The code and detail of a refusal, or "ok". */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const cause = (error as { cause?: { code?: string; detail?: string } })
      .cause;
    return { code: cause?.code, detail: cause?.detail };
  }
}

describe("a field's rules on its values", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const page = plainBrowsers(() => db)();
  let token = "";
  let tableId = "";

  const as = () => page.call({ authorization: `Bearer ${token}` });
  const insert = (values: Record<string, string | number | null>) =>
    as().rows.insertMany({ tableId, rows: [values] });

  beforeAll(async () => {
    const created = await createTestDatabase("field_rules");
    db = created.db;
    close = created.close;
    const owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await writeSettings(db, owner, { mfaScope: "admins" });
    token = (await createApiToken(db, owner, "owner", { days: 1 })).token;
    tableId = (
      await insertTable(db, owner, {
        baseId: (await insertBase(db, owner, { name: "Ward" })).id,
        name: "Patients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          {
            name: "age",
            label: "Age",
            fieldType: "number",
            config: { min: "0", max: "130" },
          },
          {
            name: "code",
            label: "Code",
            fieldType: "text",
            config: { mask: "AA-####" },
          },
          {
            name: "initials",
            label: "Initials",
            fieldType: "text",
            config: { maxLength: 3 },
          },
        ],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("takes a row whose values fit, the bounds themselves included", async () => {
    expect(
      await refusal(insert({ age: "130", code: "fr-0012", initials: "ÉLA" })),
    ).toBe("ok");
    expect(await refusal(insert({ age: 0, code: null }))).toBe("ok");
  });

  it("refuses a value past a rule, saying the rule, on a new row and a change", async () => {
    expect(await refusal(insert({ age: "130.5" }))).toEqual({
      code: "value_out_of_range",
      detail: "0 – 130",
    });
    expect(await refusal(insert({ age: -1 }))).toMatchObject({
      code: "value_out_of_range",
    });
    expect(await refusal(insert({ code: "FR-12" }))).toEqual({
      code: "value_mismatch",
      detail: "AA-####",
    });
    expect(await refusal(insert({ initials: "ABCD" }))).toEqual({
      code: "value_too_long",
      detail: "3",
    });
    const { rows } = await as().rows.read({ tableId, limit: 10 });
    const rowId = rows[0]?.id as string;
    expect(rowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await refusal(
        as().rows.updateMany({
          tableId,
          updates: [{ rowId, values: { code: "12-ABCD" } }],
        }),
      ),
    ).toMatchObject({ code: "value_mismatch" });
  });

  it("holds a field's settings to its rules, and refuses the setting they replace", async () => {
    const add = (
      fieldType: "number" | "text",
      config: Record<string, unknown>,
    ) =>
      refusal(
        as().catalog.addColumn({
          tableId,
          name: `f_${randomBytes(3).toString("hex")}`,
          label: `F ${randomBytes(3).toString("hex")}`,
          fieldType,
          config,
        }),
      );
    expect(await add("number", { min: "1", max: "10" })).toBe("ok");
    expect(await add("text", { mask: "###", maxLength: 3 })).toBe("ok");
    for (const [fieldType, config] of [
      ["number", { min: "10", max: "1" }],
      ["number", { nonNegative: true }],
      ["number", { min: "0", defaultValue: -2 }],
      ["text", { mask: "AA\\" }],
    ] as const) {
      expect(await add(fieldType, config)).toMatchObject({
        code: "invalid_column",
      });
    }
  });
});
