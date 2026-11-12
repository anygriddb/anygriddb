import { describe, expect, it } from "vitest";
import { saveQueue, withoutSaved } from "./view-patch";

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
});
