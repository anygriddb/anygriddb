import { JOB_KINDS, JOB_STATUSES } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Bus } from "./realtime/bus.js";
import { CELL_TOKEN, cellLockKey, gridChannel } from "./realtime/channels.js";
import { acquireLock } from "./realtime/locks.js";

const MAX_MESSAGE_CHARS = 16_384;
/**
 * The socket server's own options. A page's message holds ASCII tokens only,
 * so one the parser accepts is never more bytes than characters: anything
 * longer is refused while it arrives (close 1009), not read whole and then
 * dropped. Without it a socket takes frames of 100 MiB, and holds some
 * before its session is known.
 */
export const SOCKET_OPTIONS = {
  options: { maxPayload: MAX_MESSAGE_CHARS },
} as const;
/** How often each socket is checked and told the link is alive (ADR 0049). */
export const BEAT_MS = 25_000;
const BEAT = JSON.stringify({ type: "beat" });
const token = z.string().regex(CELL_TOKEN);
const cellValue = z.union([
  z.string().max(4_000),
  z.number(),
  z.boolean(),
  z.null(),
]);

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), channel: token }),
  z.object({ type: z.literal("unsubscribe"), channel: token }),
  z.object({
    type: z.literal("presence"),
    channel: token,
    viewId: token.optional(),
    rowId: token.optional(),
    column: token.optional(),
  }),
  z.object({
    type: z.literal("lock"),
    channel: token,
    rowId: token,
    column: token,
  }),
]);

const relayMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("refresh"), channel: token }),
  z.object({
    type: z.literal("patch"),
    channel: token,
    rowId: token,
    column: token,
    value: cellValue,
  }),
  z.object({
    type: z.literal("lock"),
    channel: token,
    rowId: token,
    column: token,
    acquired: z.boolean(),
  }),
  z.object({
    type: z.literal("delete"),
    channel: token,
    rowId: token,
  }),
  z.object({
    type: z.literal("rows"),
    channel: token,
    op: z.enum(["insert", "update", "delete", "refresh"]),
    rowIds: z.array(token).max(300),
  }),
  z.object({ type: z.literal("stale"), channel: token }),
  z.object({
    type: z.literal("presence"),
    channel: token,
    userId: token,
    name: z.string().max(80),
    viewId: token.optional(),
    rowId: token.optional(),
    column: token.optional(),
    gone: z.boolean().optional(),
  }),
  z.object({ type: z.literal("catalog"), channel: token }),
  z.object({ type: z.literal("notification"), channel: token }),
  z.object({
    type: z.literal("job"),
    channel: token,
    jobId: token,
    kind: z.enum(JOB_KINDS),
    status: z.enum(JOB_STATUSES),
    done: z.int().min(0),
    total: z.int().min(0).nullable(),
  }),
]);

type ClientMessage = z.infer<typeof clientMessage>;
type SocketState = {
  channels: Set<string>;
  userId: string;
  name: string;
  /** SHA-256 of the session cookie that opened this socket. */
  sessionTokenHash: string;
  /** Messages of one socket are handled in order, one at a time. */
  queue: Promise<void>;
  /** Answered the last ping: the link still carries traffic. */
  alive: boolean;
};
type GridDecision = "ok" | "denied" | "enroll";
export type GridAuthorizer = (
  userId: string,
  channel: string,
  action: "read" | "write",
) => Promise<GridDecision>;
/** Whether the session that opened the socket is still live. */
export type SessionAlive = (tokenHash: string) => Promise<boolean>;

export function parseClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > MAX_MESSAGE_CHARS) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = clientMessage.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

function rawText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

export function acceptRelay(payload: string): string | undefined {
  return relayPayload(payload);
}

function relayPayload(payload: string): string | undefined {
  if (payload.length > MAX_MESSAGE_CHARS) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = relayMessage.safeParse(json);
  return parsed.success ? JSON.stringify(parsed.data) : undefined;
}

/**
 * The WebSocket side of realtime. Each process keeps its own sockets and
 * the channels they subscribed to; messages from every process arrive on
 * the bus (ADR 0009). Cell locks live in `ephemeral_locks`.
 */
export class GridHub {
  private readonly sockets = new Map<WebSocket, SocketState>();

  constructor(
    private readonly bus: Bus,
    private readonly db: Database,
    private readonly authorize: GridAuthorizer,
    private readonly log: (
      level: "warn" | "error",
      error: unknown,
      message: string,
    ) => void,
    private readonly sessionAlive: SessionAlive = () => Promise.resolve(true),
  ) {
    this.bus.onMessage((channel, payload) => {
      const safe = relayPayload(payload);
      if (!safe) {
        return;
      }
      for (const [socket, state] of this.sockets) {
        if (!state.channels.has(channel) || socket.readyState !== socket.OPEN) {
          continue;
        }
        socket.send(safe);
      }
    });
    // Messages sent while the listener was down are lost: every open tab
    // re-reads what it shows.
    this.bus.onReconnect(() => {
      for (const [socket, state] of this.sockets) {
        if (socket.readyState !== socket.OPEN) continue;
        for (const channel of state.channels) {
          socket.send(
            JSON.stringify({
              type: "stale",
              channel: channel.slice("grid:".length),
            }),
          );
        }
      }
    });
  }

  /**
   * Takes a signed-in socket. `early` is what the page sent while its
   * session was looked up, handled first and in order: a page subscribes
   * as soon as its link opens.
   */
  add(
    socket: WebSocket,
    userId: string,
    name = "",
    early: readonly unknown[] = [],
    sessionTokenHash = "",
  ): void {
    const state: SocketState = {
      channels: new Set(),
      userId,
      name: name.slice(0, 80),
      sessionTokenHash,
      queue: Promise.resolve(),
      alive: true,
    };
    this.sockets.set(socket, state);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.send(JSON.stringify({ type: "hello" }));
    // Authorization is asynchronous: without a queue, an unsubscribe sent
    // just before a subscribe could finish last and silence the channel.
    const enqueue = (task: () => Promise<void>) => {
      state.queue = state.queue
        .then(task)
        .catch((error: unknown) => this.log("error", error, "realtime failed"));
    };
    for (const raw of early) {
      const text = rawText(raw);
      enqueue(() => this.onClient(socket, state, text));
    }
    socket.on("message", (raw: unknown) => {
      const text = rawText(raw);
      enqueue(() => this.onClient(socket, state, text));
    });
    socket.on("close", () => {
      enqueue(() => this.remove(socket, state));
    });
  }

  /**
   * One heartbeat round (ADR 0049). A socket that did not answer the last
   * ping is dead (a laptop asleep, a dropped NAT entry) and is cut, which
   * tells the others its presence is gone. The rest are pinged, and sent a
   * message the page can see too: a browser hides pings from it.
   */
  beat(): void {
    for (const [socket, state] of this.sockets) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      if (socket.readyState !== socket.OPEN) continue;
      state.alive = false;
      socket.ping();
      socket.send(BEAT);
    }
  }

  /** Beats every `everyMs` until the returned function stops it. */
  startHeartbeat(everyMs = BEAT_MS): () => void {
    const timer = setInterval(() => {
      this.beat();
    }, everyMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  /**
   * Closes an account's sockets in this process. The app reconnects and
   * subscribes again, so each channel is authorized afresh: after a member
   * is removed from a base, or with 4401 once their sessions are ended.
   */
  closeUser(userId: string, code: 4000 | 4401 = 4401): number {
    let closed = 0;
    for (const [socket, state] of this.sockets) {
      if (state.userId !== userId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.close(code, code === 4401 ? "Unauthorized" : "Reauthorize");
      closed += 1;
    }
    return closed;
  }

  /**
   * Closes sockets opened with one session cookie. Logout ends that
   * session only: other devices of the same account keep their links.
   */
  closeSession(tokenHash: string, code: 4000 | 4401 = 4401): number {
    if (!tokenHash) return 0;
    let closed = 0;
    for (const [socket, state] of this.sockets) {
      if (state.sessionTokenHash !== tokenHash) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.close(code, code === 4401 ? "Unauthorized" : "Reauthorize");
      closed += 1;
    }
    return closed;
  }

  /** Closes every socket in this process but one account's. */
  closeAllBut(userId: string): number {
    let closed = 0;
    for (const [socket, state] of this.sockets) {
      if (state.userId === userId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.close(4401, "Unauthorized");
      closed += 1;
    }
    return closed;
  }

  private async remove(socket: WebSocket, state: SocketState): Promise<void> {
    this.sockets.delete(socket);
    for (const channel of state.channels) {
      await this.bus
        .publish(
          channel,
          JSON.stringify({
            type: "presence",
            channel: channel.slice("grid:".length),
            userId: state.userId,
            name: state.name,
            gone: true,
          }),
        )
        .catch((error: unknown) => this.log("error", error, "realtime failed"));
    }
  }

  private async onClient(
    socket: WebSocket,
    state: SocketState,
    raw: string,
  ): Promise<void> {
    if (!this.sockets.has(socket)) {
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed) {
      socket.send(
        JSON.stringify({ type: "error", message: "Invalid message" }),
      );
      return;
    }
    if (state.sessionTokenHash) {
      try {
        if (!(await this.sessionAlive(state.sessionTokenHash))) {
          socket.close(4401, "Unauthorized");
          return;
        }
      } catch (error) {
        this.log("error", error, "realtime failed");
        socket.close(1011, "Internal error");
        return;
      }
    }
    let decision: GridDecision;
    try {
      decision = await this.authorize(
        state.userId,
        parsed.channel,
        parsed.type === "lock" ? "write" : "read",
      );
    } catch (error) {
      this.log("error", error, "realtime failed");
      socket.send(
        JSON.stringify({ type: "error", message: "Request rejected" }),
      );
      return;
    }
    if (decision !== "ok") {
      this.log(
        "warn",
        undefined,
        decision === "enroll" ? "mfa enrollment required" : "access denied",
      );
      socket.send(
        JSON.stringify({ type: "error", message: "Request rejected" }),
      );
      return;
    }
    try {
      const channel = gridChannel(parsed.channel);
      if (parsed.type === "subscribe") {
        state.channels.add(channel);
        socket.send(
          JSON.stringify({ type: "subscribed", channel: parsed.channel }),
        );
        return;
      }
      if (parsed.type === "unsubscribe") {
        state.channels.delete(channel);
        return;
      }
      if (parsed.type === "presence") {
        if (!state.channels.has(channel)) {
          return;
        }
        await this.bus.publish(
          channel,
          JSON.stringify({ ...parsed, userId: state.userId, name: state.name }),
        );
        return;
      }
      // Every other message type returned above: this is a cell lock.
      const acquired = await acquireLock(this.db, {
        key: cellLockKey(parsed.channel, parsed.rowId, parsed.column),
        owner: state.userId,
        ttlSeconds: 30,
      });
      await this.bus.publish(channel, JSON.stringify({ ...parsed, acquired }));
    } catch (error) {
      this.log("error", error, "realtime failed");
      socket.send(
        JSON.stringify({ type: "error", message: "Request rejected" }),
      );
    }
  }
}
