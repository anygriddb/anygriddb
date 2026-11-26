import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  declarationSchema,
  declaredPermissions,
  demand,
  granted,
  holds,
  runDeclared,
  watchDemands,
  type Demand,
} from "./declaration.js";

const nobody = {
  isAdmin: false,
  isSupport: false,
  isAuditor: false,
  instanceRoles: [],
};

describe("a check under its way in's declaration", () => {
  it("lets through what the role gives and the way in declares, and is heard", () => {
    const heard: Demand[] = [];
    const stop = watchDemands((demanded) => heard.push(demanded));
    try {
      runDeclared("rows.read", { asks: ["rows.read"] }, () => {
        demand("viewer", "rows.read");
      });
      expect(heard).toEqual([
        { entry: "rows.read", permission: "rows.read", granted: true },
      ]);
    } finally {
      stop();
    }
  });

  it("refuses what the role does not give, as every guard refuses", () => {
    const refusal = (check: () => void): string => {
      try {
        check();
      } catch (error) {
        return error instanceof AppError ? error.code : "thrown";
      }
      return "ok";
    };
    expect(
      runDeclared("rows.insert", { asks: ["rows.write"] }, () =>
        refusal(() => demand("viewer", "rows.write")),
      ),
    ).toBe("access_denied");
    expect(
      runDeclared("api.get", { asks: ["rows.read"] }, () =>
        refusal(() => demand(null, "rows.read", "not_found")),
      ),
    ).toBe("not_found");
  });

  it("fails, under the tests, a check its way in did not declare", () => {
    expect(() =>
      runDeclared("rows.read", { asks: ["rows.read"] }, () =>
        granted("owner", "data.export"),
      ),
    ).toThrow("rows.read asks data.export without declaring it");
    // An `also` or a filter declares as well.
    expect(
      runDeclared(
        "catalog.createView",
        { asks: ["rows.read"], also: ["views.manage"] },
        () => granted("viewer", "views.manage"),
      ),
    ).toBe(false);
  });

  it("asks a permission of Administration of what the account is", () => {
    runDeclared("admin.users", { asks: ["accounts.help"] }, () => {
      expect(holds({ ...nobody, isSupport: true }, "accounts.help")).toBe(true);
      expect(holds(nobody, "accounts.help")).toBe(false);
      expect(
        holds(
          { ...nobody, instanceRoles: ["account_manager"] },
          "accounts.help",
        ),
      ).toBe(true);
    });
    expect(() =>
      runDeclared("admin.users", { asks: ["accounts.help"] }, () =>
        holds({ ...nobody, isAdmin: true }, "access.grant"),
      ),
    ).toThrow("without declaring it");
  });
});

describe("the shape of a declaration", () => {
  it("names what it asks, filters by, or the exception it is", () => {
    expect(declarationSchema.safeParse({ asks: ["rows.read"] }).success).toBe(
      true,
    );
    expect(
      declarationSchema.safeParse({ filters: ["base.manage"] }).success,
    ).toBe(true);
    expect(
      declarationSchema.safeParse({
        exception: "publicLink",
        asks: ["rows.read", "publish"],
      }).success,
    ).toBe(true);
    expect([
      ...declaredPermissions({ asks: ["rows.read"], also: ["publish"] }),
    ]).toEqual(["rows.read", "publish"]);
  });

  it("refuses one that says nothing, or a permission no catalogue has", () => {
    expect(declarationSchema.safeParse({}).success).toBe(false);
    expect(declarationSchema.safeParse({ asks: [] }).success).toBe(false);
    expect(declarationSchema.safeParse({ asks: ["rows.fly"] }).success).toBe(
      false,
    );
    expect(declarationSchema.safeParse({ exception: "whim" }).success).toBe(
      false,
    );
    expect(
      declarationSchema.safeParse({ asks: ["rows.read"], extra: true }).success,
    ).toBe(false);
  });
});
