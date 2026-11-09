import { describe, expect, it } from "vitest";
import { withTransactionRetry } from "./retry.js";

describe("withTransactionRetry", () => {
  it("returns the value when the transaction commits", async () => {
    const result = await withTransactionRetry(
      async () => "ok",
      3,
      0,
      async () => {},
    );
    expect(result).toBe("ok");
  });

  it("retries a deadlock and then rejects a different error", async () => {
    let attempts = 0;
    const result = await withTransactionRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("deadlock"), { code: "40P01" });
        }
        return attempts;
      },
      3,
      0,
      async () => {},
    );
    expect(result).toBe(3);

    await expect(
      withTransactionRetry(
        async () => {
          throw Object.assign(new Error("unique"), { code: "23505" });
        },
        3,
        0,
        async () => {},
      ),
    ).rejects.toThrow(/unique/);
  });
});
