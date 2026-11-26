import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ceilingOf } from "@anygriddb/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RIGHTS_CHANNEL } from "./realtime/channels.js";
import {
  acceptRelay,
  MAX_BUFFERED_BYTES,
  MAX_CHANNELS_PER_SOCKET,
  MAX_QUEUED_MESSAGES,
  parseClientMessage,
  PRESENCE_BURST,
  SOCKET_OPTIONS,
} from "./ws.js";

/** The sockets an account may have open, as shipped. */
const SOCKETS_SHIPPED = ceilingOf("sockets.per_account");

describe("the socket server", () => {
  it("takes a message up to the parser's limit and closes on a longer one", async () => {
    const app = Fastify();
    await app.register(websocket, SOCKET_OPTIONS);
    const received: number[] = [];
    app.get("/ws", { websocket: true }, (socket) => {
      socket.on("message", (raw: Buffer) => {
        received.push(raw.length);
      });
    });
    await app.ready();
    try {
      const socket = await app.injectWS("/ws");
      const closed = new Promise<number>((resolve) => {
        socket.on("close", resolve);
      });
      socket.send("x".repeat(16_384));
      socket.send("x".repeat(16_385));
      // Refused as it arrives: the server closes with "message too big".
      expect(await closed).toBe(1009);
      expect(received).toEqual([16_384]);
    } finally {
      await app.close();
    }
  });
});

describe("websocket messages", () => {
  it("accepts a bounded subscribe and rejects hostile payloads", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "subscribe", channel: "demo" }),
      ),
    ).toEqual({
      type: "subscribe",
      channel: "demo",
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "subscribe", channel: "demo; DROP" }),
      ),
    ).toBeUndefined();
    expect(parseClientMessage("not-json")).toBeUndefined();
    expect(parseClientMessage("x".repeat(16_385))).toBeUndefined();
  });

  it("relays a row deletion and drops an unknown event", () => {
    const rowId = "00000000-0000-4000-8000-000000000001";
    expect(
      acceptRelay(JSON.stringify({ type: "delete", channel: rowId, rowId })),
    ).toBe(JSON.stringify({ type: "delete", channel: rowId, rowId }));
    expect(acceptRelay(JSON.stringify({ type: "drop" }))).toBeUndefined();
  });

  it("relays a bare notification signal and nothing more", () => {
    const userId = "00000000-0000-4000-8000-000000000002";
    expect(
      acceptRelay(JSON.stringify({ type: "notification", channel: userId })),
    ).toBe(JSON.stringify({ type: "notification", channel: userId }));
    expect(
      acceptRelay(
        JSON.stringify({ type: "notification", channel: userId, body: "x" }),
      ),
    ).not.toContain("body");
  });
});

describe("GridHub ordering", () => {
  it("keeps a channel after unsubscribe then subscribe, even if checks finish out of order", async () => {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    // A bus that hands messages to the hub as another process would.
    let deliver: (channel: string, message: string) => void = () => undefined;
    const bus = {
      publish: async () => undefined,
      onMessage: (handler: typeof deliver) => {
        deliver = handler;
      },
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    const channel = "00000000-0000-4000-8000-0000000000aa";
    let calls = 0;
    // The first check (the unsubscribe) is slow, the second one fast.
    const authorize = async () => {
      calls += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, calls === 2 ? 30 : calls === 3 ? 0 : 0),
      );
      return "ok" as const;
    };
    const hub = new GridHub(bus, {} as never, authorize, () => undefined);
    const sent: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => sent.push(data),
    });
    hub.add(socket as never, "user");
    socket.emit("message", JSON.stringify({ type: "subscribe", channel }));
    socket.emit("message", JSON.stringify({ type: "unsubscribe", channel }));
    socket.emit("message", JSON.stringify({ type: "subscribe", channel }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    deliver(`grid:${channel}`, JSON.stringify({ type: "stale", channel }));
    expect(sent.at(-1)).toBe(JSON.stringify({ type: "stale", channel }));
  });
});

describe("GridHub heartbeat", () => {
  async function hubWithSocket() {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    const published: string[] = [];
    const bus = {
      publish: async (_channel: string, message: string) => {
        published.push(message);
      },
      onMessage: () => undefined,
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    const hub = new GridHub(
      bus,
      {} as never,
      async () => "ok" as const,
      () => undefined,
    );
    const sent: string[] = [];
    const calls = { ping: 0, terminate: 0 };
    const pings: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => sent.push(data),
      ping: (data?: unknown) => {
        calls.ping += 1;
        pings.push(data);
      },
      terminate: () => {
        calls.terminate += 1;
        socket.emit("close");
      },
    });
    hub.add(socket as never, "user", "Ada");
    return { hub, socket, sent, calls, published, pings };
  }

  it("pings a live socket and tells the page the link is alive", async () => {
    const { hub, socket, sent, calls, pings } = await hubWithSocket();
    hub.beat();
    socket.emit("pong", pings.at(-1));
    hub.beat();
    expect(calls).toEqual({ ping: 2, terminate: 0 });
    expect(sent.filter((data) => data === '{"type":"beat"}')).toHaveLength(2);
  });

  it("asks something new of each ping", async () => {
    const { hub, socket, pings } = await hubWithSocket();
    hub.beat();
    socket.emit("pong", pings.at(-1));
    hub.beat();
    expect(Buffer.isBuffer(pings[0])).toBe(true);
    expect(pings[0]).not.toEqual(pings[1]);
  });

  it.each([
    ["with nothing", () => undefined],
    ["with an empty answer", () => Buffer.alloc(0)],
    ["with the wrong answer", () => Buffer.from("not-the-ping")],
  ])("cuts a socket that answers %s", async (_name, answer) => {
    const { hub, socket, calls } = await hubWithSocket();
    hub.beat();
    socket.emit("pong", answer());
    hub.beat();
    expect(calls).toEqual({ ping: 1, terminate: 1 });
  });

  it("does not take an answer to an older ping", async () => {
    const { hub, socket, calls, pings } = await hubWithSocket();
    hub.beat();
    const first = pings.at(-1);
    socket.emit("pong", first);
    hub.beat();
    socket.emit("pong", first);
    hub.beat();
    expect(calls).toEqual({ ping: 2, terminate: 1 });
  });

  it("cuts a socket that stopped answering, and says its presence is gone", async () => {
    const { hub, socket, calls, published } = await hubWithSocket();
    const channel = "00000000-0000-4000-8000-0000000000bb";
    socket.emit("message", JSON.stringify({ type: "subscribe", channel }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    hub.beat();
    hub.beat();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual({ ping: 1, terminate: 1 });
    expect(published.at(-1)).toContain('"gone":true');
  });
});

describe("GridHub sessions", () => {
  it("closes only the socket of the session that logged out", async () => {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    const bus = {
      publish: async () => undefined,
      onMessage: () => undefined,
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    const hub = new GridHub(
      bus,
      {} as never,
      async () => "ok" as const,
      () => undefined,
    );
    const closed: string[] = [];
    function socketOf(hash: string) {
      const socket = Object.assign(new EventEmitter(), {
        OPEN: 1,
        readyState: 1,
        send: () => undefined,
        close: (_code: number, reason: string) => {
          closed.push(`${hash}:${reason}`);
          socket.readyState = 3;
        },
      });
      hub.add(socket as never, "user", "Ada", [], hash);
      return socket;
    }
    socketOf("hash-a");
    socketOf("hash-b");
    expect(hub.closeSession("hash-a")).toBe(1);
    expect(closed).toEqual(["hash-a:Unauthorized"]);
    expect(hub.closeUser("user")).toBe(1);
    expect(closed).toEqual(["hash-a:Unauthorized", "hash-b:Unauthorized"]);
  });

  it("cuts a socket whose session is no longer live", async () => {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    const bus = {
      publish: async () => undefined,
      onMessage: () => undefined,
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    let alive = true;
    const hub = new GridHub(
      bus,
      {} as never,
      async () => "ok" as const,
      () => undefined,
      async (hashes) =>
        new Map(alive ? hashes.map((hash) => [hash, "user"]) : []),
    );
    const closed: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: () => undefined,
      close: (_code: number, reason: string) => {
        closed.push(reason);
        socket.readyState = 3;
      },
    });
    const channel = "00000000-0000-4000-8000-0000000000cc";
    hub.add(socket as never, "user", "Ada", [], "live-hash");
    socket.emit("message", JSON.stringify({ type: "subscribe", channel }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toEqual([]);
    alive = false;
    socket.emit("message", JSON.stringify({ type: "subscribe", channel }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toEqual(["Unauthorized"]);
  });
});

describe("GridHub early messages", () => {
  it("handles, in order, what a page sent before its session was known", async () => {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    const bus = {
      publish: async () => undefined,
      onMessage: () => undefined,
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    const hub = new GridHub(
      bus,
      {} as never,
      async () => "ok" as const,
      () => undefined,
    );
    const sent: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => sent.push(data),
    });
    const one = "00000000-0000-4000-8000-0000000000c1";
    const two = "00000000-0000-4000-8000-0000000000c2";
    hub.add(socket as never, "user", "Ada", [
      Buffer.from(JSON.stringify({ type: "subscribe", channel: one })),
      JSON.stringify({ type: "subscribe", channel: two }),
    ]);
    socket.emit(
      "message",
      JSON.stringify({ type: "unsubscribe", channel: one }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([
      JSON.stringify({ type: "hello" }),
      JSON.stringify({ type: "subscribed", channel: one }),
      JSON.stringify({ type: "subscribed", channel: two }),
    ]);
  });
});

describe("GridHub fan-out and silent sockets", () => {
  async function hub(
    live: () => ReadonlyMap<string, string> = () => new Map(),
  ) {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    let deliver: (channel: string, message: string) => void = () => undefined;
    const bus = {
      publish: async () => undefined,
      onMessage: (handler: typeof deliver) => {
        deliver = handler;
      },
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    const asked: string[][] = [];
    const grid = new GridHub(
      bus,
      {} as never,
      async () => "ok" as const,
      () => undefined,
      async (hashes) => {
        asked.push([...hashes].sort());
        return live();
      },
    );
    function open(sessionHash = "") {
      const sent: string[] = [];
      const closed: string[] = [];
      let looked = 0;
      const socket = Object.assign(new EventEmitter(), {
        OPEN: 1,
        send: (data: string) => sent.push(data),
        close: (_code: number, reason: string) => {
          closed.push(reason);
        },
      });
      // Counts each time the hub looks at the socket to send to it.
      Object.defineProperty(socket, "readyState", {
        get: () => {
          looked += 1;
          return 1;
        },
      });
      grid.add(socket as never, "user", "Ada", [], sessionHash);
      return { socket, sent, closed, looked: () => looked };
    }
    return {
      grid,
      open,
      asked,
      deliver: (c: string, m: string) => deliver(c, m),
    };
  }
  const table = "00000000-0000-4000-8000-0000000000a1";
  const other = "00000000-0000-4000-8000-0000000000b2";
  const stale = (channel: string) => JSON.stringify({ type: "stale", channel });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("sends a message to the sockets of its channel and looks at no other", async () => {
    const { open, deliver } = await hub();
    const here = open();
    const elsewhere = open();
    here.socket.emit(
      "message",
      JSON.stringify({ type: "subscribe", channel: table }),
    );
    elsewhere.socket.emit(
      "message",
      JSON.stringify({ type: "subscribe", channel: other }),
    );
    await settle();
    const before = elsewhere.looked();
    deliver(`grid:${table}`, stale(table));
    expect(here.sent.at(-1)).toBe(stale(table));
    expect(elsewhere.sent).not.toContain(stale(table));
    expect(elsewhere.looked()).toBe(before);
  });

  it("stops sending once a socket unsubscribes or closes", async () => {
    const { open, deliver } = await hub();
    const left = open();
    const gone = open();
    for (const { socket } of [left, gone]) {
      socket.emit(
        "message",
        JSON.stringify({ type: "subscribe", channel: table }),
      );
    }
    await settle();
    left.socket.emit(
      "message",
      JSON.stringify({ type: "unsubscribe", channel: table }),
    );
    gone.socket.emit("close");
    await settle();
    deliver(`grid:${table}`, stale(table));
    expect(left.sent).not.toContain(stale(table));
    expect(gone.sent).not.toContain(stale(table));
  });

  it("closes a socket that sends nothing once its session is over", async () => {
    const { grid, open, asked } = await hub(
      () => new Map([["live-hash", "user"]]),
    );
    const live = open("live-hash");
    const twin = open("live-hash");
    const over = open("over-hash");
    const unsigned = open();
    expect(await grid.endExpiredSessions()).toBe(1);
    expect(over.closed).toEqual(["Unauthorized"]);
    expect(live.closed).toEqual([]);
    expect(twin.closed).toEqual([]);
    // A socket with no session to check is left to the other closings.
    expect(unsigned.closed).toEqual([]);
    // One question for the round, each session named once.
    expect(asked).toEqual([["live-hash", "over-hash"]]);
  });

  it("asks a socket to reconnect once its session holds other rights", async () => {
    const { grid, open } = await hub(
      () => new Map([["acting-hash", "the-person"]]),
    );
    const socket = open("acting-hash");
    expect(await grid.endExpiredSessions()).toBe(1);
    expect(socket.closed).toEqual(["Reauthorize"]);
  });

  it("asks nothing when no socket has a session to check", async () => {
    const { grid, open, asked } = await hub();
    open();
    expect(await grid.endExpiredSessions()).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("GridHub under the rights held now", () => {
  const table = "00000000-0000-4000-8000-0000000000d1";
  const row = "00000000-0000-4000-8000-0000000000d2";
  const channel = `grid:${table}`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const subscribe = JSON.stringify({ type: "subscribe", channel: table });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rig(
    options: {
      authorize?: () => Promise<"ok" | "denied">;
      /** Holds an answer, already read, until the test lets it go. */
      holdAnswer?: (
        wanted: ReadonlyMap<string, ReadonlySet<string>>,
      ) => Promise<void>;
    } = {},
  ) {
    const { EventEmitter } = await import("node:events");
    const { GridHub } = await import("./ws.js");
    let deliver: (name: string, message: string) => void = () => undefined;
    const published: Array<{ channel: string; message: string }> = [];
    const bus = {
      publish: async (name: string, message: string) => {
        published.push({ channel: name, message });
      },
      onMessage: (handler: typeof deliver) => {
        deliver = handler;
      },
      onReconnect: () => undefined,
      listening: () => true,
      close: async () => undefined,
    };
    /** What each account hears of the table; absent, it may not read it. */
    const rights = new Map<string, "rows" | "changes">();
    const asked: Array<ReadonlyMap<string, ReadonlySet<string>>> = [];
    const live = new Map<string, string>();
    let touchedDb = false;
    const db = new Proxy(
      {},
      {
        get: () => {
          touchedDb = true;
          throw new Error("no database here");
        },
      },
    );
    const grid = new GridHub(
      bus,
      db as never,
      options.authorize ?? (async () => "ok" as const),
      () => undefined,
      async () => live,
      async (wanted) => {
        asked.push(wanted);
        const answer = new Map(
          [...wanted].map(([userId, channels]) => {
            const hearing = rights.get(userId);
            return [
              userId,
              new Map(
                hearing ? [...channels].map((name) => [name, hearing]) : [],
              ),
            ] as const;
          }),
        );
        await options.holdAnswer?.(wanted);
        return answer;
      },
    );
    function open(userId: string, sessionHash = "", allowed?: number) {
      const sent: Array<Record<string, unknown>> = [];
      const closed: number[] = [];
      const socket = Object.assign(new EventEmitter(), {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send: (data: string) => {
          sent.push(JSON.parse(data) as Record<string, unknown>);
        },
        ping: () => undefined,
        close: (code: number) => {
          closed.push(code);
          socket.readyState = 3;
        },
        terminate: () => {
          closed.push(1006);
          socket.readyState = 3;
        },
      });
      grid.add(socket as never, userId, userId, [], sessionHash, allowed);
      return { socket, sent, closed };
    }
    return {
      grid,
      open,
      rights,
      asked,
      live,
      published,
      touchedDb: () => touchedDb,
      deliver: (name: string, message: string) => deliver(name, message),
    };
  }

  const heard = (sent: ReadonlyArray<Record<string, unknown>>) =>
    sent.filter(
      (message) =>
        !["hello", "subscribed", "beat"].includes(String(message.type)),
    );

  it("tells a reader with no rule which rows moved", async () => {
    const { open, rights, deliver } = await rig();
    rights.set("full", "rows");
    const reader = open("full");
    reader.socket.emit("message", subscribe);
    await settle();
    const message = {
      type: "rows",
      channel: table,
      op: "update",
      rowIds: [row],
    };
    deliver(channel, JSON.stringify(message));
    expect(heard(reader.sent)).toEqual([message]);
  });

  it.each([
    ["rows", { type: "rows", channel: table, op: "update", rowIds: [row] }],
    ["delete", { type: "delete", channel: table, rowId: row }],
    [
      "patch",
      { type: "patch", channel: table, rowId: row, column: "secret", value: 1 },
    ],
  ])(
    "tells a reader under a rule only that something moved: %s",
    async (_n, m) => {
      const { open, rights, deliver } = await rig();
      rights.set("ruled", "changes");
      const reader = open("ruled");
      reader.socket.emit("message", subscribe);
      await settle();
      deliver(channel, JSON.stringify(m));
      expect(heard(reader.sent)).toEqual([
        { type: "rows", channel: table, op: "refresh", rowIds: [] },
      ]);
    },
  );

  it("keeps a row and a field out of what a reader under a rule hears of others", async () => {
    const { open, rights, deliver } = await rig();
    rights.set("ruled", "changes");
    rights.set("full", "rows");
    const ruled = open("ruled");
    const full = open("full");
    for (const { socket } of [ruled, full]) socket.emit("message", subscribe);
    await settle();
    const presence = {
      type: "presence",
      channel: table,
      userId: "00000000-0000-4000-8000-0000000000d3",
      name: "Ada",
      viewId: "view",
      rowId: row,
      column: "secret",
    };
    const lock = {
      type: "lock",
      channel: table,
      rowId: row,
      column: "secret",
      acquired: true,
    };
    deliver(channel, JSON.stringify(presence));
    deliver(channel, JSON.stringify(lock));
    expect(heard(ruled.sent)).toEqual([
      {
        type: "presence",
        channel: table,
        userId: presence.userId,
        name: "Ada",
        viewId: "view",
      },
    ]);
    expect(heard(full.sent)).toEqual([presence, lock]);
  });

  it("does not take a cell lock from a reader under a rule", async () => {
    const { open, rights, published, touchedDb } = await rig();
    rights.set("ruled", "changes");
    const reader = open("ruled");
    reader.socket.emit(
      "message",
      JSON.stringify({ type: "lock", channel: table, rowId: row, column: "c" }),
    );
    await settle();
    expect(touchedDb()).toBe(false);
    expect(published).toEqual([]);
    expect(reader.sent.at(-1)).toEqual({
      type: "error",
      message: "Request rejected",
    });
  });

  it("leaves a channel once its right is gone, and tells the page and the others", async () => {
    const { grid, open, rights, deliver, published } = await rig();
    rights.set("kept", "rows");
    rights.set("removed", "rows");
    const kept = open("kept");
    const removed = open("removed");
    for (const { socket } of [kept, removed]) socket.emit("message", subscribe);
    await settle();
    rights.delete("removed");
    await grid.recheck();
    expect(removed.sent.at(-1)).toEqual({ type: "stale", channel: table });
    expect(published.map((item) => JSON.parse(item.message))).toContainEqual(
      expect.objectContaining({
        type: "presence",
        userId: "removed",
        gone: true,
      }),
    );
    const before = removed.sent.length;
    const message = {
      type: "rows",
      channel: table,
      op: "update",
      rowIds: [row],
    };
    deliver(channel, JSON.stringify(message));
    expect(removed.sent).toHaveLength(before);
    expect(heard(kept.sent)).toEqual([message]);
  });

  it("hears less, without a reconnection, once a rule is set", async () => {
    const { grid, open, rights, deliver } = await rig();
    rights.set("reader", "rows");
    const reader = open("reader");
    reader.socket.emit("message", subscribe);
    await settle();
    rights.set("reader", "changes");
    await grid.recheck();
    deliver(
      channel,
      JSON.stringify({
        type: "rows",
        channel: table,
        op: "update",
        rowIds: [row],
      }),
    );
    expect(reader.closed).toEqual([]);
    expect(heard(reader.sent)).toEqual([
      { type: "rows", channel: table, op: "refresh", rowIds: [] },
    ]);
  });

  it("asks once for every socket, each account and channel named once", async () => {
    const { grid, open, rights, asked } = await rig();
    rights.set("a", "rows");
    rights.set("b", "changes");
    for (const name of ["a", "a", "b"]) {
      open(name).socket.emit("message", subscribe);
    }
    await settle();
    asked.length = 0;
    await grid.recheck();
    expect(asked).toHaveLength(1);
    expect([...(asked[0]?.keys() ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(asked[0]?.get("a") ?? [])]).toEqual([table]);
  });

  it("checks again at once when another process says rights changed", async () => {
    const { open, rights, deliver } = await rig();
    rights.set("removed", "rows");
    const removed = open("removed");
    removed.socket.emit("message", subscribe);
    await settle();
    rights.delete("removed");
    deliver(RIGHTS_CHANNEL, JSON.stringify({ type: "rights" }));
    await settle();
    expect(removed.sent.at(-1)).toEqual({ type: "stale", channel: table });
  });

  it("closes at once a session another process ended", async () => {
    const { open, live, rights, deliver } = await rig();
    rights.set("user", "rows");
    live.set("kept-hash", "user");
    const kept = open("user", "kept-hash");
    const ended = open("user", "ended-hash");
    deliver(RIGHTS_CHANNEL, JSON.stringify({ type: "rights" }));
    await settle();
    expect(ended.closed).toEqual([4401]);
    expect(kept.closed).toEqual([]);
  });

  it.each(["closeUser", "closeSession", "closeAllBut"] as const)(
    "tells the other processes: %s",
    async (closing) => {
      const { grid, published } = await rig();
      grid[closing]("someone");
      await settle();
      expect(published).toEqual([
        {
          channel: RIGHTS_CHANNEL,
          message: JSON.stringify({ type: "rights" }),
        },
      ]);
    },
  );

  it("does not keep a subscribe whose answer was read before a right was taken", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const { open, rights, deliver } = await rig({
      holdAnswer: async () => {
        if (!first) return;
        first = false;
        await held;
      },
    });
    rights.set("late", "rows");
    const late = open("late");
    late.socket.emit("message", subscribe);
    await settle();
    // Its answer says yes; the right goes before the socket is following.
    rights.delete("late");
    deliver(RIGHTS_CHANNEL, JSON.stringify({ type: "rights" }));
    await settle();
    release();
    await settle();
    expect(late.sent.some((message) => message.type === "subscribed")).toBe(
      true,
    );
    expect(late.sent.at(-1)).toEqual({ type: "stale", channel: table });
    const before = late.sent.length;
    deliver(channel, JSON.stringify({ type: "stale", channel: table }));
    expect(late.sent).toHaveLength(before);
  });

  it("does not drop a channel subscribed while a check was reading", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const { grid, open, rights, deliver } = await rig({
      holdAnswer: async (wanted) => {
        if (holding && wanted.has("other") && !wanted.has("joiner")) {
          await held;
        }
      },
    });
    rights.set("other", "rows");
    const other = open("other");
    other.socket.emit("message", subscribe);
    await settle();
    const joiner = open("joiner");
    holding = true;
    // The round has read, knowing nothing of the joiner, and has not applied.
    const round = grid.recheck();
    await settle();
    rights.set("joiner", "rows");
    joiner.socket.emit("message", subscribe);
    await settle();
    release();
    await round;
    const message = { type: "stale", channel: table };
    deliver(channel, JSON.stringify(message));
    expect(joiner.sent.at(-1)).toEqual(message);
  });

  it("leaves a channel when a message on it is refused", async () => {
    let decision: "ok" | "denied" = "ok";
    const { open, rights, deliver } = await rig({
      authorize: async () => decision,
    });
    rights.set("reader", "rows");
    const reader = open("reader");
    reader.socket.emit("message", subscribe);
    await settle();
    decision = "denied";
    reader.socket.emit(
      "message",
      JSON.stringify({ type: "presence", channel: table }),
    );
    await settle();
    expect(reader.sent).toContainEqual({ type: "stale", channel: table });
    const before = reader.sent.length;
    deliver(channel, JSON.stringify({ type: "catalog", channel: table }));
    expect(reader.sent).toHaveLength(before);
  });

  it("leaves a channel on request, even when nothing can be checked", async () => {
    let failing = false;
    const { open, rights, deliver } = await rig({
      authorize: async () => {
        if (failing) throw new Error("database down");
        return "ok";
      },
    });
    rights.set("reader", "rows");
    const reader = open("reader");
    reader.socket.emit("message", subscribe);
    await settle();
    failing = true;
    reader.socket.emit(
      "message",
      JSON.stringify({ type: "unsubscribe", channel: table }),
    );
    await settle();
    const before = reader.sent.length;
    deliver(channel, JSON.stringify({ type: "catalog", channel: table }));
    expect(reader.sent).toHaveLength(before);
  });

  it("keeps a channel when only a lock is refused", async () => {
    let decision: "ok" | "denied" = "ok";
    const { open, rights, deliver } = await rig({
      authorize: async () => decision,
    });
    rights.set("viewer", "rows");
    const viewer = open("viewer");
    viewer.socket.emit("message", subscribe);
    await settle();
    decision = "denied";
    viewer.socket.emit(
      "message",
      JSON.stringify({ type: "lock", channel: table, rowId: row, column: "c" }),
    );
    await settle();
    const message = { type: "catalog", channel: table };
    deliver(channel, JSON.stringify(message));
    expect(viewer.sent.at(-1)).toEqual(message);
  });

  it("relays that the views of a table changed, and nothing it cannot read as that", async () => {
    const { open, rights, deliver } = await rig();
    rights.set("reader", "rows");
    const reader = open("reader");
    reader.socket.emit("message", subscribe);
    await settle();
    const message = { type: "views", channel: table, tableId: row };
    deliver(channel, JSON.stringify(message));
    expect(reader.sent.at(-1)).toEqual(message);
    // Without the table it is about, it tells nothing a page can act on.
    const before = reader.sent.length;
    deliver(channel, JSON.stringify({ type: "views", channel: table }));
    expect(reader.sent).toHaveLength(before);
  });

  it("closes a socket past the buffer, and sends below it", async () => {
    const { open, rights, deliver } = await rig();
    rights.set("reader", "rows");
    const reader = open("reader");
    reader.socket.emit("message", subscribe);
    await settle();
    const message = { type: "stale", channel: table };
    reader.socket.bufferedAmount = MAX_BUFFERED_BYTES;
    deliver(channel, JSON.stringify(message));
    expect(heard(reader.sent)).toEqual([message]);
    expect(reader.closed).toEqual([]);
    reader.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    deliver(channel, JSON.stringify(message));
    expect(reader.closed).toEqual([1013]);
    expect(heard(reader.sent)).toEqual([message]);
  });

  it("refuses a socket past an account's limit, and only that account's", async () => {
    const { open } = await rig();
    for (let count = 0; count < SOCKETS_SHIPPED; count += 1) {
      expect(open("busy").closed).toEqual([]);
    }
    const refused = open("busy");
    expect(refused.closed).toEqual([1013]);
    expect(refused.sent).toEqual([]);
    expect(open("other").closed).toEqual([]);
  });

  it("holds the sockets an account may have open as Administration sets them", async () => {
    const { open } = await rig();
    for (let count = 0; count < 4; count += 1) {
      expect(open("busy", "", 4).closed).toEqual([]);
    }
    expect(open("busy", "", 4).closed).toEqual([1013]);
    // Raised, the next one is taken.
    expect(open("busy", "", 5).closed).toEqual([]);
  });

  it("makes room when one of an account's sockets closes", async () => {
    const { open } = await rig();
    const first = open("busy");
    for (let count = 1; count < SOCKETS_SHIPPED; count += 1) {
      open("busy");
    }
    first.socket.emit("close");
    await settle();
    expect(open("busy").closed).toEqual([]);
  });

  it("limits what one socket says of where it is, and lets it speak again", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { open, rights, published } = await rig();
    rights.set("talker", "rows");
    const talker = open("talker");
    talker.socket.emit("message", subscribe);
    await settle();
    const presence = JSON.stringify({
      type: "presence",
      channel: table,
      rowId: row,
    });
    for (let count = 0; count < PRESENCE_BURST + 30; count += 1) {
      talker.socket.emit("message", presence);
    }
    await settle();
    await settle();
    expect(published).toHaveLength(PRESENCE_BURST);
    now += 2_000;
    talker.socket.emit("message", presence);
    await settle();
    expect(published).toHaveLength(PRESENCE_BURST + 1);
  });

  it("closes a socket that sends faster than it is answered", async () => {
    const never = new Promise<never>(() => undefined);
    const { open } = await rig({ authorize: () => never });
    const flood = open("flood");
    for (let count = 0; count <= MAX_QUEUED_MESSAGES; count += 1) {
      flood.socket.emit("message", subscribe);
    }
    expect(flood.closed).toEqual([1008]);
  });

  it("refuses a channel past a socket's limit", async () => {
    const { open, rights } = await rig();
    rights.set("many", "rows");
    const many = open("many");
    for (let count = 0; count <= MAX_CHANNELS_PER_SOCKET; count += 1) {
      const id = `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
      many.socket.emit(
        "message",
        JSON.stringify({ type: "subscribe", channel: id }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      many.sent.filter((message) => message.type === "subscribed"),
    ).toHaveLength(MAX_CHANNELS_PER_SOCKET);
    expect(many.sent.at(-1)).toEqual({
      type: "error",
      message: "Request rejected",
    });
  });
});
