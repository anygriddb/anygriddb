/**
 * Who may call each procedure of Administration, as what they are: an
 * administrator, support, an auditor, an account manager, a source
 * manager. The answer is computed from what each procedure declares it
 * asks, and held to `admin-reach.freeze.json`: a procedure that opens to
 * someone new, or closes, changes that file, and is a decision of its own.
 * `FREEZE_WRITE=1` writes the file again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { INSTANCE_CALLERS, type InstanceCaller } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { declarationSchema, type Declaration } from "../access/declaration.js";
import { auditorOpen, partsOpen } from "./admin-procedure.js";
import { adminRouter } from "./admin-router.js";

const FREEZE = new URL("./admin-reach.freeze.json", import.meta.url);

type Walked = {
  path: string;
  type: "query" | "mutation" | "subscription";
  declaration: Declaration;
};

const PROCEDURES: Walked[] = Object.entries(
  adminRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: Walked["type"]; meta?: unknown } }
  >,
).map(([path, procedure]) => ({
  path: `admin.${path}`,
  type: procedure._def.type,
  declaration: declarationSchema.parse(procedure._def.meta),
}));

/** Who may call, by what they are. */
function reachOf({ type, declaration }: Walked): InstanceCaller[] {
  return INSTANCE_CALLERS.filter((caller) =>
    caller === "auditor"
      ? auditorOpen(type, declaration)
      : partsOpen([caller], declaration),
  );
}

describe("who may call Administration", () => {
  const reach = Object.fromEntries(
    PROCEDURES.map((walked) => [walked.path, reachOf(walked)] as const).sort(
      ([a], [b]) => a.localeCompare(b),
    ),
  );

  it("is what the freeze says, procedure by procedure", () => {
    if (process.env.FREEZE_WRITE) {
      writeFileSync(FREEZE, `${JSON.stringify(reach, null, 2)}\n`);
    }
    const frozen = JSON.parse(readFileSync(FREEZE, "utf8")) as Record<
      string,
      string[]
    >;
    expect(reach).toEqual(frozen);
  });

  it("never opens to the parts given apart what gives access, erases, acts as someone or takes data out", () => {
    for (const path of [
      "admin.setAdmin",
      "admin.setSupport",
      "admin.setAuditor",
      "admin.setInstanceRole",
      "admin.setBaseRole",
      "admin.removeBaseRole",
      "admin.groups.setBaseRole",
      "admin.people.add",
      "admin.erase",
      "admin.startActing",
      "admin.handOver",
      "admin.exportAccountData",
      "admin.revokeAllTokens",
      "admin.endOtherSessions",
      "admin.updateSettings",
      "admin.audit",
    ]) {
      expect(reach[path], path).toBeDefined();
      expect(reach[path], path).not.toContain("account_manager");
      expect(reach[path], path).not.toContain("source_manager");
    }
  });

  it("lets an auditor read, export the trails, and change nothing else", () => {
    const query = { asks: ["settings.manage" as const] };
    // A read added tomorrow is open to the auditor without a word.
    expect(auditorOpen("query", query)).toBe(true);
    expect(auditorOpen("mutation", query)).toBe(false);
    expect(auditorOpen("mutation", { asks: ["trails.export"] })).toBe(true);
    // The read that reaches a client's database is not the auditor's.
    expect(auditorOpen("query", { asks: ["sources.browse"] })).toBe(false);
    expect(auditorOpen("subscription", query)).toBe(false);
    expect(auditorOpen("mutation", { exception: "proof" })).toBe(false);
  });

  it("opens the proof to whoever holds a part of Administration, and to nobody else", () => {
    expect(partsOpen(["account_manager"], { exception: "proof" })).toBe(true);
    expect(partsOpen(["auditor"], { exception: "proof" })).toBe(false);
    expect(partsOpen([], { exception: "proof" })).toBe(false);
    expect(partsOpen(["support"], { asks: ["accounts.manage"] })).toBe(false);
    expect(partsOpen(["account_manager"], { asks: ["accounts.manage"] })).toBe(
      true,
    );
  });
});
