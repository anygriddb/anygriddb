import { describe, expect, it } from "vitest";
import { printRecord } from "./print-record";

describe("printing a record", () => {
  it("marks the page while printing, and unmarks it after", () => {
    let after: (() => void) | undefined;
    const body = { dataset: {} as Record<string, string> };
    let printed = false;
    printRecord({
      document: { body } as never,
      print: () => {
        printed = true;
        expect(body.dataset.printing).toBe("record");
      },
      addEventListener: ((type: string, listener: () => void) => {
        if (type === "afterprint") after = listener;
      }) as never,
    });
    expect(printed).toBe(true);
    after?.();
    expect(body.dataset.printing).toBeUndefined();
  });

  it("leaves the page unmarked when the browser never reports the end", () => {
    const body = { dataset: {} as Record<string, string> };
    printRecord({
      document: { body } as never,
      print: () => undefined,
      addEventListener: (() => undefined) as never,
    });
    // Without `afterprint` the mark stays, and only print styles read it.
    expect(body.dataset.printing).toBe("record");
  });
});
