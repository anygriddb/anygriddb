import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionQueue } from "./connection-queue.js";

type Fake = { id: number; dropped: boolean };

function fakes(failures = 0, waitMs?: number) {
  const opened: Fake[] = [];
  const closed: Fake[] = [];
  let left = failures;
  const queue = connectionQueue<Fake>(
    1,
    {
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
    },
    waitMs,
  );
  return { queue, opened, closed };
}

describe("connectionQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("serves the one waiting when a connection comes back in time", async () => {
    vi.useFakeTimers();
    const { queue } = fakes(0, 1_000);
    const first = await queue.acquire();
    const second = queue.acquire();
    await vi.advanceTimersByTimeAsync(999);
    queue.release(first, false);
    await expect(second).resolves.toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("turns away a request once the queue is as long as the pool", async () => {
    const { queue } = fakes();
    const first = await queue.acquire();
    const second = queue.acquire();
    await expect(queue.acquire()).rejects.toMatchObject({
      code: "source_timeout",
    });
    queue.release(first, false);
    await expect(second).resolves.toBe(first);
  });

  it("turns away the one waiting past its time, and keeps the connection", async () => {
    vi.useFakeTimers();
    const { queue, opened } = fakes(0, 1_000);
    const first = await queue.acquire();
    const second = queue.acquire();
    const refused = expect(second).rejects.toMatchObject({
      code: "source_timeout",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await refused;
    queue.release(first, false);
    await expect(queue.acquire()).resolves.toBe(first);
    expect(opened).toHaveLength(1);
  });
});
