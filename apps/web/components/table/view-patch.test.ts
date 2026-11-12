import { describe, expect, it } from "vitest";
import { readKey, saveQueue, withoutSaved } from "./view-patch";

describe("a view's settings saved one after another", () => {
  it("drops a setting once its own save is stored, and keeps a newer one", () => {
    const first = [{ column: "name", direction: "asc" as const }];
    const second = [{ column: "status", direction: "asc" as const }];
    const local = { groupBy: second, rowHeight: "tall" as const };
    // The first save answers after the second change: its value is gone.
    expect(withoutSaved(local, { groupBy: first })).toEqual(local);
    expect(withoutSaved(local, { groupBy: second })).toEqual({
      rowHeight: "tall",
    });
  });

  it("stores saves in the order they were asked, past a failed one", async () => {
    const queue = saveQueue();
    const stored: string[] = [];
    const slow = (name: string, ms: number) => () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          stored.push(name);
          resolve(name);
        }, ms),
      );
    const failed = queue(() => Promise.reject(new Error("refused")));
    const first = queue(slow("name", 20));
    const second = queue(slow("status", 1));
    await expect(failed).rejects.toThrow("refused");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "name",
      "status",
    ]);
    expect(stored).toEqual(["name", "status"]);
  });

  it("gives a read one key whatever the order of its settings' keys", () => {
    const local = {
      filter: {
        conjunction: "and",
        conditions: [{ op: "is", column: "status", value: "Done" }],
      },
      sort: [{ direction: "desc", column: "name" }],
    };
    const stored = {
      sort: [{ column: "name", direction: "desc" }],
      filter: {
        conditions: [{ column: "status", op: "is", value: "Done" }],
        conjunction: "and",
      },
    };
    expect(readKey(local)).toBe(readKey(stored));
  });

  it("tells reads apart when a setting differs", () => {
    expect(readKey({ sort: [{ column: "name", direction: "asc" }] })).not.toBe(
      readKey({ sort: [{ column: "name", direction: "desc" }] }),
    );
    // The order of a list is the order of the sort.
    expect(readKey({ sort: [{ column: "a" }, { column: "b" }] })).not.toBe(
      readKey({ sort: [{ column: "b" }, { column: "a" }] }),
    );
    expect(readKey({ filter: undefined })).toBe(readKey({}));
  });
});
