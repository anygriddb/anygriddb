import { describe, expect, it } from "vitest";
import { RELAXATIONS, relaxationSchema } from "./relaxations";

const SOURCE = "01a20eab-d2d2-7a3f-8569-9dc74a139929";

describe("relaxationSchema", () => {
  it("names a source for a relaxation kept for one, and none for the instance", () => {
    expect(
      relaxationSchema.safeParse({ key: "source.plaintext", sourceId: SOURCE })
        .success,
    ).toBe(true);
    expect(
      relaxationSchema.safeParse({ key: "notify.private_networks" }).success,
    ).toBe(true);
  });

  it("refuses a key outside the catalogue, or a scope that does not fit", () => {
    for (const value of [
      { key: "source.plaintext" },
      { key: "notify.private_networks", sourceId: SOURCE },
      { key: "app.http" },
      { key: "source.plaintext", sourceId: SOURCE, extra: true },
    ]) {
      expect(relaxationSchema.safeParse(value).success).toBe(false);
    }
  });

  it("gives every key a scope and a consequence confirmed from 1", () => {
    for (const entry of Object.values(RELAXATIONS)) {
      expect(["instance", "source"]).toContain(entry.scope);
      expect(entry.consequence).toBeGreaterThan(0);
    }
  });
});
