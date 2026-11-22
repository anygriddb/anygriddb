import { describe, expect, it } from "vitest";
import { loggedError } from "../logged-error.js";
import {
  rethrowAuditError,
  uniqueViolation,
  violatedUnique,
} from "./pg-error.js";
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
  it("names the index a unique violation met, through what wraps it", () => {
    expect(violatedUnique(unique())).toBe("users_email_unique");
    expect(
      violatedUnique(new Error("transaction failed", { cause: unique() })),
    ).toBe("users_email_unique");
  });

  it("says a table is converting only when its guard refused", () => {
    expect(
      thrownBy(Object.assign(new Error("Table converting"), { code: "P0001" })),
    ).toMatchObject({ code: "table_converting" });
    // A type mismatch is a fault of the statement, and stays one.
    const mismatch = Object.assign(new Error("column is of type numeric"), {
      code: "42804",
    });
    expect(thrownBy(mismatch)).toBe(mismatch);
  });

  it("names no index for another failure", () => {
    expect(
      violatedUnique(
        Object.assign(new Error("violates foreign key"), {
          code: "23503",
          constraint: "orders_client_fk",
        }),
      ),
    ).toBeUndefined();
    expect(violatedUnique(new Error("boom"))).toBeUndefined();
  });

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
