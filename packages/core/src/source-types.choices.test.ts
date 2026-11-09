import { describe, expect, it } from "vitest";
import { checkChoices, withChoices } from "./source-types";

describe("checkChoices", () => {
  it("reads a list as PostgreSQL prints it", () => {
    expect(
      checkChoices(
        "CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'it''s sent'::character varying])::text[])))",
        "status",
      ),
    ).toEqual(["draft", "it's sent"]);
    expect(
      checkChoices(
        "CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))",
        "status",
      ),
    ).toEqual(["a", "b"]);
    expect(
      checkChoices(
        "CHECK (((kind = 'x'::text) OR (kind = 'y'::text)))",
        "kind",
      ),
    ).toEqual(["x", "y"]);
  });

  it("reads a list as SQL Server prints it", () => {
    expect(
      checkChoices(
        "([status]='cancelled' OR [status]='shipped' OR [status]=N'draft')",
        "status",
      ),
    ).toEqual(["cancelled", "shipped", "draft"]);
  });

  it("reads a list as MySQL and MariaDB print it", () => {
    expect(
      checkChoices("(`status` in (_utf8mb4'draft',_utf8mb4'sent'))", "status"),
    ).toEqual(["draft", "sent"]);
    expect(checkChoices("`status` in ('draft','sent')", "status")).toEqual([
      "draft",
      "sent",
    ]);
    // MySQL 8 escapes the quotes of CHECK_CLAUSE.
    expect(
      checkChoices(
        "((`state` = _latin1\\'open\\') or (`state` = _latin1\\'closed\\'))",
        "state",
      ),
    ).toEqual(["open", "closed"]);
  });

  it("refuses anything else", () => {
    expect(checkChoices("CHECK ((price >= (0)::numeric))", "price")).toBeNull();
    expect(checkChoices("(`qty` > 0)", "qty")).toBeNull();
    expect(checkChoices("([status]='a' AND [other]='b')", "status")).toBeNull();
    expect(checkChoices("([status]='a' OR [other]='b')", "status")).toBeNull();
    expect(checkChoices("([status] like 'a%')", "status")).toBeNull();
    expect(checkChoices("([status]<>'a')", "status")).toBeNull();
    expect(checkChoices("json_valid(`attrs`)", "attrs")).toBeNull();
    expect(checkChoices(null, "status")).toBeNull();
  });

  it("turns a text column into a single select, nothing else", () => {
    expect(withChoices({ fieldType: "text", readOnly: false }, ["a"])).toEqual({
      fieldType: "single_select",
      readOnly: false,
      options: ["a"],
    });
    expect(
      withChoices({ fieldType: "number", readOnly: false }, ["1"]),
    ).toEqual({ fieldType: "number", readOnly: false });
  });
});
