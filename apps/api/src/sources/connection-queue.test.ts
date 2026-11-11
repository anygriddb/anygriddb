import { describe, expect, it } from "vitest";
import { connectionQueue } from "./connection-queue.js";

type Fake = { id: number; dropped: boolean };

function fakes(failures = 0) {
  const opened: Fake[] = [];
  const closed: Fake[] = [];
  let left = failures;
  const queue = connectionQueue<Fake>(1, {
    open: () => {
      if (left > 0) {
        left -= 1;
        return Promise.reject(new Error("refused"));
      }
      const connection = { id: opened.length + 1, dropped: false };
      opened.push(connection);
      return Promise.resolve(connection);
    },
    usable: (connection) => !connection.dropped,
    close: (connection) => {
      closed.push(connection);
    },
  });
  return { queue, opened, closed };
}

describe("connectionQueue", () => {
  it("gives a healthy connection back to the one waiting", async () => {
    const { queue, opened } = fakes();
    const first = await queue.acquire();
    const second = queue.acquire();
    queue.release(first, false);
    await expect(second).resolves.toBe(first);
    expect(opened).toHaveLength(1);
  });

  it("hands a broken connection's place to the one waiting", async () => {
    const { queue, opened, closed } = fakes();
    const first = await queue.acquire();
    const second = queue.acquire();
    queue.release(first, true);
    await expect(second).resolves.toMatchObject({ id: 2 });
    expect(closed).toEqual([first]);
    expect(opened).toHaveLength(2);
  });

  it("hands on the place of a connection that failed to open", async () => {
    const { queue } = fakes(1);
    const first = queue.acquire();
    const second = queue.acquire();
    await expect(first).rejects.toThrow("refused");
    await expect(second).resolves.toMatchObject({ id: 1 });
  });

  it("replaces an idle connection the server dropped", async () => {
    const { queue, closed } = fakes();
    const first = await queue.acquire();
    queue.release(first, false);
    first.dropped = true;
    await expect(queue.acquire()).resolves.toMatchObject({ id: 2 });
    expect(closed).toEqual([first]);
  });

  it("turns the ones waiting away when it ends, and refuses new ones", async () => {
    const { queue, closed } = fakes();
    const first = await queue.acquire();
    const second = queue.acquire();
    await queue.end();
    await expect(second).rejects.toMatchObject({ code: "source_unreachable" });
    await expect(queue.acquire()).rejects.toMatchObject({
      code: "source_unreachable",
    });
    queue.release(first, false);
    expect(closed).toEqual([first]);
  });
});
