import { describe, expect, it } from "vitest";
import { deliveryOutcome } from "./webhook-deliveries";

describe("deliveryOutcome", () => {
  it("says a delivery not tried yet is waiting, not that it is retried", () => {
    expect(deliveryOutcome({ status: "pending", attempts: 0 })).toBe("waiting");
  });

  it("says a delivery tried and left pending has a retry ahead", () => {
    expect(deliveryOutcome({ status: "pending", attempts: 1 })).toBe("retry");
    expect(deliveryOutcome({ status: "pending", attempts: 3 })).toBe("retry");
  });

  it("says what ended: sent, or given up", () => {
    expect(deliveryOutcome({ status: "success", attempts: 1 })).toBe("sent");
    expect(deliveryOutcome({ status: "failed", attempts: 4 })).toBe("failed");
  });
});
