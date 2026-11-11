import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, type ServerMessage } from "./realtime-connection";

/** A WebSocket the test opens, feeds, and cuts. */
class FakeLink {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  cut(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(onUnauthorized = vi.fn()) {
  const links: FakeLink[] = [];
  const connection = new Connection({
    url: () => "wss://grid.test/ws",
    open: () => {
      const link = new FakeLink();
      links.push(link);
      return link as unknown as WebSocket;
    },
    random: () => 0.5,
  });
  connection.onUnauthorized(onUnauthorized);
  const message = vi.fn<(message: ServerMessage) => void>();
  const resync = vi.fn<() => void>();
  connection.start();
  vi.advanceTimersByTime(0);
  return { connection, links, message, resync, onUnauthorized };
}

/** The last link, which the connection is using. */
function current(links: FakeLink[]): FakeLink {
  const link = links.at(-1);
  if (!link) throw new Error("no link opened");
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("realtime connection", () => {
  it("re-reads nothing on a page whose first link opened", () => {
    const { connection, links, message, resync } = setup();
    connection.subscribe("t1", { message, resync });
    current(links).accept();
    expect(current(links).sent).toEqual([{ type: "subscribe", channel: "t1" }]);
    current(links).receive({ type: "subscribed", channel: "t1" });
    current(links).receive({
      type: "rows",
      channel: "t1",
      op: "update",
      rowIds: ["r1"],
    });
    expect(resync).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledOnce();
  });

  it("re-reads after a lost link, once subscribed again and not before", () => {
    const { connection, links, message, resync } = setup();
    connection.subscribe("t1", { message, resync });
    current(links).accept();
    current(links).receive({ type: "subscribed", channel: "t1" });
    current(links).cut();
    vi.advanceTimersByTime(500);
    expect(links).toHaveLength(2);
    current(links).accept();
    expect(current(links).sent).toEqual([{ type: "subscribe", channel: "t1" }]);
    expect(resync).not.toHaveBeenCalled();
    current(links).receive({ type: "subscribed", channel: "t1" });
    current(links).receive({ type: "subscribed", channel: "t1" });
    expect(resync).toHaveBeenCalledOnce();
  });

  it("re-reads a channel opened while cut off, once the link is back", () => {
    const { connection, links, message, resync } = setup();
    current(links).accept();
    current(links).cut();
    connection.subscribe("t2", { message, resync });
    vi.advanceTimersByTime(500);
    current(links).accept();
    current(links).receive({ type: "subscribed", channel: "t2" });
    expect(resync).toHaveBeenCalledOnce();
  });

  it("re-reads when the server says it lost messages", () => {
    const { connection, links, message, resync } = setup();
    connection.subscribe("t1", { message, resync });
    current(links).accept();
    current(links).receive({ type: "stale", channel: "t1" });
    expect(resync).toHaveBeenCalledOnce();
    expect(message).not.toHaveBeenCalled();
  });

  it("drops a link that went silent and opens another", () => {
    const { links } = setup();
    current(links).accept();
    vi.advanceTimersByTime(60_000);
    current(links).receive({ type: "beat" });
    vi.advanceTimersByTime(60_000);
    expect(links[0]?.closed).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(links[0]?.closed).toBe(true);
    vi.advanceTimersByTime(500);
    expect(links).toHaveLength(2);
  });

  it("says the page is cut off only after 10 s without a link", () => {
    const { connection, links } = setup();
    const changed = vi.fn();
    connection.onDownChange(changed);
    current(links).accept();
    current(links).cut();
    vi.advanceTimersByTime(500);
    current(links).accept();
    vi.advanceTimersByTime(20_000);
    expect(connection.isDown()).toBe(false);

    current(links).cut();
    vi.advanceTimersByTime(9_999);
    expect(connection.isDown()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(connection.isDown()).toBe(true);
    current(links).accept();
    expect(connection.isDown()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("opens a link at once when woken, instead of waiting", () => {
    const { connection, links } = setup();
    current(links).cut();
    vi.advanceTimersByTime(500);
    current(links).cut();
    expect(links).toHaveLength(2);
    connection.wake();
    expect(links).toHaveLength(3);
    connection.wake();
    expect(links).toHaveLength(3);
  });

  it("asks for the session again when the server says it is over", () => {
    const { links, onUnauthorized } = setup();
    current(links).accept();
    current(links).cut(1000);
    expect(onUnauthorized).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    current(links).cut(4401);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
