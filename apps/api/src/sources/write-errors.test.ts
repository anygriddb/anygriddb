import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { writeError } from "./write-errors.js";

const failure = (fields: Record<string, unknown>) =>
  Object.assign(
    new Error(typeof fields.message === "string" ? fields.message : "failed"),
    fields,
  );

describe("writeError", () => {
  it("names what PostgreSQL refused, and the column or rule", () => {
    expect(
      writeError("postgres", failure({ code: "23502", column: "label" })),
    ).toMatchObject({ code: "source_value_required", detail: "label" });
    expect(
      writeError(
        "postgres",
        failure({ code: "23505", constraint: "ledger_label_key" }),
      ),
    ).toMatchObject({
      code: "source_value_duplicate",
      detail: "ledger_label_key",
    });
    // A referenced row: 23503, or 23001 for a RESTRICT key on PostgreSQL 18.
    for (const code of ["23503", "23001"]) {
      expect(
        writeError("postgres", failure({ code, constraint: "orders_fk" })),
      ).toMatchObject({ code: "source_value_reference", detail: "orders_fk" });
    }
    expect(writeError("postgres", failure({ code: "22P02" }))?.code).toBe(
      "source_value_invalid",
    );
    expect(writeError("postgres", failure({ code: "55P03" }))?.code).toBe(
      "source_row_busy",
    );
    expect(
      writeError(
        "postgres",
        failure({ code: "P0001", message: "Invoice\n  is closed" }),
      ),
    ).toMatchObject({
      code: "source_write_refused",
      detail: "Invoice is closed",
    });
    expect(writeError("postgres", failure({ code: "08006" }))).toBeUndefined();
  });

  it("reads MySQL's error numbers and the column its message quotes", () => {
    expect(
      writeError(
        "mysql",
        failure({
          errno: 1406,
          message: "Data too long for column 'note' at row 1",
        }),
      ),
    ).toMatchObject({ code: "source_value_too_long", detail: "note" });
    expect(writeError("mariadb", failure({ errno: 1452 }))?.code).toBe(
      "source_value_reference",
    );
    expect(writeError("mysql", failure({ errno: 1142 }))?.code).toBe(
      "source_write_denied",
    );
    expect(writeError("mysql", failure({ errno: 2013 }))).toBeUndefined();
    expect(
      writeError(
        "mysql",
        failure({
          errno: 1364,
          message: "Field 'name' doesn't have a default value",
        }),
      ),
    ).toMatchObject({ code: "source_value_required", detail: "name" });
  });

  it("tells SQL Server's foreign keys from its checks, and its own raised errors", () => {
    expect(
      writeError(
        "sqlserver",
        failure({
          number: 547,
          message:
            'The UPDATE statement conflicted with the FOREIGN KEY constraint "FK_team".',
        }),
      )?.code,
    ).toBe("source_value_reference");
    expect(
      writeError(
        "sqlserver",
        failure({
          number: 547,
          message:
            'The UPDATE statement conflicted with the CHECK constraint "CK_qty".',
        }),
      ),
    ).toMatchObject({ code: "source_value_check", detail: "CK_qty" });
    expect(
      writeError("sqlserver", failure({ number: 50001, message: "Closed" })),
    ).toMatchObject({ code: "source_write_refused", detail: "Closed" });
  });

  it("reads the first of the errors tedious gathers", () => {
    // A refused statement, then 3621: "The statement has been terminated."
    const gathered = new AggregateError([
      failure({
        number: 515,
        message:
          "Cannot insert the value NULL into column 'name', table 'erp.dbo.customers'; column does not allow nulls. INSERT fails.",
      }),
      failure({ number: 3621, message: "The statement has been terminated." }),
    ]);
    expect(writeError("sqlserver", gathered)).toMatchObject({
      code: "source_value_required",
      detail: "name",
    });
  });

  it("keeps an error people may already read", () => {
    const known = new AppError("source_conflict");
    expect(writeError("postgres", known)).toBe(known);
  });
});
