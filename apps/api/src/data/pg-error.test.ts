import { describe, expect, it } from "vitest";
import { loggedError } from "../logged-error.js";
import { rethrowAuditError, uniqueViolation } from "./pg-error.js";
import { isUniqueViolation } from "./schema-ops.js";

const unique = () =>
  Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint: "users_email_unique",
    detail: "Key (email)=(ada@example.com) already exists.",
  });

function thrownBy(error: unknown): unknown {
  try {
    rethrowAuditError(error);
  } catch (thrown) {
    return thrown;
  }
}

describe("PostgreSQL errors", () => {
  it("lets a unique violation through, for the caller that names it", () => {
    const raised = unique();
    expect(thrownBy(raised)).toBe(raised);
    const wrapped = new Error("transaction failed", { cause: raised });
    expect(thrownBy(wrapped)).toBe(wrapped);
    expect(isUniqueViolation(thrownBy(wrapped))).toBe(true);
  });

  it("names what a trigger refused", () => {
    expect(thrownBy(new Error("Row locked"))).toMatchObject({
      code: "row_locked",
    });
  });

  it("makes a unique violation public by its constraint, never its value", () => {
    const duplicate = uniqueViolation(unique());
    expect(duplicate).toMatchObject({
      code: "duplicate_values",
      detail: "users_email_unique",
    });
    expect(uniqueViolation(new Error("other"))).toBeNull();
    // What the log keeps of it: the code and the constraint, no row value.
    expect(loggedError(unique())).toMatchObject({
      code: "23505",
      constraint: "users_email_unique",
    });
    expect(JSON.stringify(loggedError(unique()))).not.toContain("ada@");
  });
});
