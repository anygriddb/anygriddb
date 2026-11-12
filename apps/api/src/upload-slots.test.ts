import { describe, expect, it } from "vitest";
import { uploadSlots } from "./upload-slots.js";

describe("uploadSlots", () => {
  it("gives slots up to its ceiling, then refuses", () => {
    const slots = uploadSlots(2);
    const first = slots.take();
    const second = slots.take();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(slots.take()).toBeUndefined();
    first?.();
    expect(slots.take()).toBeDefined();
  });

  it("counts a slot given back twice once", () => {
    const slots = uploadSlots(1);
    const done = slots.take();
    done?.();
    done?.();
    expect(slots.busy).toBe(0);
    expect(slots.take()).toBeDefined();
    expect(slots.take()).toBeUndefined();
  });
});
