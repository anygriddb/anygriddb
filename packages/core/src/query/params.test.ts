import { describe, expect, it } from "vitest";
import { rewritePlaceholders, withoutUnreadValues } from "./params";

describe("withoutUnreadValues", () => {
  it("leaves a statement that reads every value as it is", () => {
    const statement = { text: "select $1, $2, $1", values: ["a", "b"] };
    expect(withoutUnreadValues(statement)).toBe(statement);
  });

  it("drops the values nothing reads and numbers the rest again", () => {
    expect(
      withoutUnreadValues({
        text: "select $2 where x = $4 and y = $2 limit $5",
        values: ["dropped", "kept", "dropped too", 7, 10],
        columns: ["x"],
      }),
    ).toEqual({
      text: "select $1 where x = $2 and y = $1 limit $3",
      values: ["kept", 7, 10],
      columns: ["x"],
    });
  });

  it("does not take quoted text or a quoted name for a placeholder", () => {
    expect(
      withoutUnreadValues({
        text: `select '$1 it''s $2', "$1" from t where a = $3`,
        values: ["unread", "unread", "read"],
      }),
    ).toEqual({
      text: `select '$1 it''s $2', "$1" from t where a = $1`,
      values: ["read"],
    });
  });

  it("refuses a placeholder no value stands behind", () => {
    expect(() =>
      withoutUnreadValues({ text: "select $2", values: ["only one"] }),
    ).toThrow("placeholder");
  });
});

describe("rewritePlaceholders", () => {
  it("renders each placeholder where it stands", () => {
    const seen: number[] = [];
    const text = rewritePlaceholders(
      "a = $2 or b = $10 or c = '$3'",
      10,
      (n) => {
        seen.push(n);
        return "?";
      },
    );
    expect(text).toBe("a = ? or b = ? or c = '$3'");
    expect(seen).toEqual([2, 10]);
  });
});
