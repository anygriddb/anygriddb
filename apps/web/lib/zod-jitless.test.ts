import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "./zod-jitless";

describe("the app's zod", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds and reads a schema without asking for eval", () => {
    const probe = vi.spyOn(globalThis, "Function");
    const schema = z.object({ count: z.number() });
    expect(schema.parse({ count: 1 })).toEqual({ count: 1 });
    expect(schema.safeParse({ count: "one" }).success).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
