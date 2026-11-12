import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { acceptRelay, parseClientMessage, SOCKET_OPTIONS } from "./ws.js";

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
    const socket = Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => sent.push(data),
      ping: () => {
        calls.ping += 1;
      },
      terminate: () => {
        calls.terminate += 1;
        socket.emit("close");
      },
    });
    hub.add(socket as never, "user", "Ada");
    return { hub, socket, sent, calls, published };
  }

  it("pings a live socket and tells the page the link is alive", async () => {
    const { hub, socket, sent, calls } = await hubWithSocket();
    hub.beat();
    socket.emit("pong");
    hub.beat();
    expect(calls).toEqual({ ping: 2, terminate: 0 });
    expect(sent.filter((data) => data === '{"type":"beat"}')).toHaveLength(2);
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
      async () => alive,
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
  async function hub(live: () => ReadonlySet<string> = () => new Set()) {
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
      async () => true,
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
    const { grid, open, asked } = await hub(() => new Set(["live-hash"]));
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

  it("asks nothing when no socket has a session to check", async () => {
    const { grid, open, asked } = await hub();
    open();
    expect(await grid.endExpiredSessions()).toBe(0);
    expect(asked).toEqual([]);
  });
});
