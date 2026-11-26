import { randomBytes } from "node:crypto";
import { JOB_KINDS, JOB_STATUSES, ceilingOf } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { WebSocket } from "ws";
import { z } from "zod";
import { type Declaration, runDeclared } from "./access/declaration.js";
import type { ChannelHearing } from "./auth/access.js";
import { websocketRefused } from "./observability.js";
import type { Bus } from "./realtime/bus.js";
import {
  CELL_TOKEN,
  cellLockKey,
  gridChannel,
  publishRightsChanged,
  RIGHTS_CHANNEL,
} from "./realtime/channels.js";
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
const BEAT_MS = 25_000;
const BEAT = JSON.stringify({ type: "beat" });
/**
 * What may wait for one socket to read. A page that keeps up holds a few
 * messages at most; one that stopped is closed (1013) rather than kept in
 * this process's memory, and reads again what it shows when it comes back.
 */
export const MAX_BUFFERED_BYTES = 1_048_576;
/** A page follows a few channels; a dashboard, one per table it shows. */
export const MAX_CHANNELS_PER_SOCKET = ceilingOf("sockets.channels_per_socket");
/** Messages of one socket waiting: all its channels asked again, and more. */
export const MAX_QUEUED_MESSAGES = 256;
/** "I am on this cell", as fast as someone moves, then a few a second. */
export const PRESENCE_BURST = 20;
const PRESENCE_PER_SECOND = 5;
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
  z.object({ type: z.literal("views"), channel: token, tableId: token }),
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
type RelayMessage = z.infer<typeof relayMessage>;
/** A channel a socket follows. */
type Followed = {
  hearing: ChannelHearing;
  /** The round of checks under way when it was last allowed. */
  since: number;
};
type SocketState = {
  channels: Map<string, Followed>;
  userId: string;
  name: string;
  /** SHA-256 of the session cookie that opened this socket. */
  sessionTokenHash: string;
  /** Messages of one socket are handled in order, one at a time. */
  queue: Promise<void>;
  /** Messages waiting in `queue`. */
  queued: number;
  /** Answered the last ping: the link still carries traffic. */
  alive: boolean;
  /** What the ping under way asks to be sent back. */
  pingToken: Buffer | null;
  /** How many presence messages it may send now, and when that was counted. */
  presenceTokens: number;
  presenceAt: number;
};
type GridDecision = "ok" | "denied" | "enroll";
type GridAuthorizer = (
  userId: string,
  channel: string,
  permission: "rows.read" | "rows.write",
) => Promise<GridDecision>;
/** Of these sessions, the live ones and whose rights each holds now. */
type SessionIdentities = (
  tokenHashes: readonly string[],
) => Promise<ReadonlyMap<string, string>>;
/** For each account, the channels it may read now and what it hears of them. */
type ChannelRights = (
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
) => Promise<ReadonlyMap<string, ReadonlyMap<string, ChannelHearing>>>;

/**
 * A session that is over is told so. One that now holds someone else's
 * rights is asked to reconnect, and opens again as who it is now.
 */
function closeForIdentity(
  socket: { close: (code: number, reason: string) => void },
  identity: string | undefined,
): void {
  if (identity === undefined) socket.close(4401, "Unauthorized");
  else socket.close(4000, "Reauthorize");
}

/**
 * What each message a page sends asks: following a table's rows, telling
 * where one is, holding a cell while editing it. Leaving asks nothing.
 */
export const MESSAGE_ASKS: Record<ClientMessage["type"], Declaration> = {
  subscribe: { asks: ["rows.read"] },
  unsubscribe: { exception: "socket" },
  presence: { asks: ["rows.read"] },
  lock: { asks: ["rows.write"] },
};

/** The kind a message says it is, before the whole of it is read. */
function messageKind(raw: string): ClientMessage["type"] | undefined {
  return parseClientMessage(raw)?.type;
}

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
  const message = relayed(payload);
  return message && JSON.stringify(message);
}

function relayed(payload: string): RelayMessage | undefined {
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
  return parsed.success ? parsed.data : undefined;
}

/**
 * A message as a reader under a row or field rule hears it: that something
 * moved, never which row or which field. Their page reads again with its
 * own rights. Undefined when there is nothing left to say.
 */
function withoutRowOrField(message: RelayMessage): RelayMessage | undefined {
  switch (message.type) {
    case "rows":
    case "patch":
    case "delete":
      return {
        type: "rows",
        channel: message.channel,
        op: "refresh",
        rowIds: [],
      };
    case "lock":
      return undefined;
    case "presence":
      return {
        type: "presence",
        channel: message.channel,
        userId: message.userId,
        name: message.name,
        ...(message.viewId === undefined ? {} : { viewId: message.viewId }),
        ...(message.gone === undefined ? {} : { gone: message.gone }),
      };
    default:
      return message;
  }
}

/**
 * The WebSocket side of realtime. Each process keeps its own sockets and
 * the channels they subscribed to; messages from every process arrive on
 * the bus (ADR 0009). Cell locks live in `ephemeral_locks`.
 */
export class GridHub {
  private readonly sockets = new Map<WebSocket, SocketState>();
  /** The sockets of each channel: a message goes to these, and no further. */
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  /** How many sockets each account has open on this process. */
  private readonly perAccount = new Map<string, number>();
  /** Counts the changes of rights heard, to catch one during a check. */
  private rightsHeard = 0;
  /** The last round of checks started. */
  private round = 0;
  private checking: Promise<void> | undefined;
  /** Counts the checks asked for: one asked during a check makes another. */
  private checksAsked = 0;

  /** Open browser sockets on this process. */
  connections(): number {
    return this.sockets.size;
  }

  constructor(
    private readonly bus: Bus,
    private readonly db: Database,
    private readonly authorize: GridAuthorizer,
    private readonly log: (
      level: "warn" | "error",
      error: unknown,
      message: string,
    ) => void,
    private readonly sessionIdentities?: SessionIdentities,
    private readonly channelRights?: ChannelRights,
  ) {
    this.bus.onMessage((channel, payload) => {
      if (channel === RIGHTS_CHANNEL) {
        this.rightsHeard += 1;
        void this.recheck();
        return;
      }
      // Only the channel's own sockets: a busy table does not cost the
      // tabs open on every other one.
      const sockets = this.subscribers.get(channel);
      if (!sockets) return;
      const message = relayed(payload);
      if (!message) {
        return;
      }
      const whole = JSON.stringify(message);
      const narrowed = withoutRowOrField(message);
      const reduced = narrowed && JSON.stringify(narrowed);
      for (const socket of sockets) {
        const hearing = this.sockets
          .get(socket)
          ?.channels.get(channel)?.hearing;
        const data =
          hearing === "rows"
            ? whole
            : hearing === "changes"
              ? reduced
              : undefined;
        if (data !== undefined) this.transmit(socket, data);
      }
    });
    // Messages sent while the listener was down are lost, a change of
    // rights among them: every open tab re-reads what it shows.
    this.bus.onReconnect(() => {
      for (const [socket, state] of this.sockets) {
        for (const channel of state.channels.keys()) {
          this.transmit(
            socket,
            JSON.stringify({
              type: "stale",
              channel: channel.slice("grid:".length),
            }),
          );
        }
      }
      this.rightsHeard += 1;
      void this.recheck();
    });
  }

  /**
   * Every message to a socket goes through here: one that stopped reading
   * is closed instead of being kept in memory without bound.
   */
  private transmit(socket: WebSocket, data: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      websocketRefused("slow_reader");
      this.log("warn", undefined, "realtime reader too slow, closed");
      socket.close(1013, "Too slow");
      return;
    }
    socket.send(data);
  }

  /**
   * Takes a signed-in socket. `early` is what the page sent while its
   * session was looked up, handled first and in order: a page subscribes
   * as soon as its link opens. One tab is one socket: `allowed` is many
   * tabs, as Administration sets it, and refuses an account's flood.
   */
  add(
    socket: WebSocket,
    userId: string,
    name = "",
    early: readonly unknown[] = [],
    sessionTokenHash = "",
    allowed: number = ceilingOf("sockets.per_account"),
  ): void {
    const open = this.perAccount.get(userId) ?? 0;
    if (open >= allowed) {
      websocketRefused("too_many_sockets");
      this.log("warn", undefined, "too many sockets for one account");
      socket.close(1013, "Too many connections");
      return;
    }
    this.perAccount.set(userId, open + 1);
    const state: SocketState = {
      channels: new Map(),
      userId,
      name: name.slice(0, 80),
      sessionTokenHash,
      queue: Promise.resolve(),
      queued: 0,
      alive: true,
      pingToken: null,
      presenceTokens: PRESENCE_BURST,
      presenceAt: Date.now(),
    };
    this.sockets.set(socket, state);
    // Only the answer to the ping under way: a client that reads nothing
    // cannot know it, however many pongs it sends unasked.
    socket.on("pong", (data: unknown) => {
      if (
        state.pingToken &&
        Buffer.isBuffer(data) &&
        data.equals(state.pingToken)
      ) {
        state.alive = true;
        state.pingToken = null;
      }
    });
    this.transmit(socket, JSON.stringify({ type: "hello" }));
    // Authorization is asynchronous: without a queue, an unsubscribe sent
    // just before a subscribe could finish last and silence the channel.
    const enqueue = (task: () => Promise<void>) => {
      state.queued += 1;
      state.queue = state.queue
        .then(task)
        .catch((error: unknown) => this.log("error", error, "realtime failed"))
        .then(() => {
          state.queued -= 1;
        });
    };
    const take = (raw: unknown) => {
      if (state.queued >= MAX_QUEUED_MESSAGES) {
        if (socket.readyState === socket.OPEN) {
          websocketRefused("too_many_messages");
          this.log("warn", undefined, "realtime client sends too fast");
          socket.close(1008, "Too many messages");
        }
        return;
      }
      const text = rawText(raw);
      enqueue(() => this.onDeclared(socket, state, text));
    };
    for (const raw of early) take(raw);
    socket.on("message", take);
    socket.on("close", () => {
      enqueue(() => this.remove(socket, state));
    });
  }

  /**
   * One heartbeat round (ADR 0049). A socket that did not answer the last
   * ping is dead (a laptop asleep, a dropped NAT entry) and is cut, which
   * tells the others its presence is gone. The rest are pinged, with
   * something to send back, and sent a message the page can see too: a
   * browser hides pings from it.
   */
  beat(): void {
    for (const [socket, state] of this.sockets) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      if (socket.readyState !== socket.OPEN) continue;
      state.alive = false;
      state.pingToken = randomBytes(8);
      socket.ping(state.pingToken);
      this.transmit(socket, BEAT);
    }
  }

  /**
   * Closes the sockets whose session is over (expired, ended elsewhere, of
   * an account since disabled) or holds another person's rights than when
   * they opened, as acting starts or ends. A socket that sends nothing is checked
   * here, since nothing else looks at it; one question covers them all.
   */
  async endExpiredSessions(): Promise<number> {
    const hashes = new Set<string>();
    for (const state of this.sockets.values()) {
      if (state.sessionTokenHash) hashes.add(state.sessionTokenHash);
    }
    if (hashes.size === 0 || !this.sessionIdentities) return 0;
    const live = await this.sessionIdentities([...hashes]);
    let closed = 0;
    for (const [socket, state] of this.sockets) {
      if (!state.sessionTokenHash) continue;
      const identity = live.get(state.sessionTokenHash);
      if (identity === state.userId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      closeForIdentity(socket, identity);
      closed += 1;
    }
    return closed;
  }

  /**
   * Asks again whether each socket's session and channels still hold: at
   * each heartbeat, for what ends with nobody saying so (an opening's hour,
   * a change made elsewhere), and at once when a process says rights
   * changed. Calls during a check make one more after it, not one each.
   */
  recheck(): Promise<void> {
    this.checksAsked += 1;
    if (this.checking) return this.checking;
    this.checking = this.runChecks().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async runChecks(): Promise<void> {
    let answered = -1;
    while (answered !== this.checksAsked) {
      answered = this.checksAsked;
      try {
        await this.endExpiredSessions();
        await this.checkChannels();
      } catch (error) {
        // The next heartbeat asks again.
        this.log("error", error, "realtime failed");
        return;
      }
    }
  }

  /**
   * One question for every socket. A channel no longer allowed is left, and
   * its page told to read again, which is refused; a channel subscribed
   * while this was reading has an answer of its own and is left alone.
   */
  private async checkChannels(): Promise<void> {
    if (!this.channelRights) return;
    const wanted = new Map<string, Set<string>>();
    for (const state of this.sockets.values()) {
      if (state.channels.size === 0) continue;
      const channels = wanted.get(state.userId) ?? new Set<string>();
      for (const channel of state.channels.keys()) {
        channels.add(channel.slice("grid:".length));
      }
      wanted.set(state.userId, channels);
    }
    if (wanted.size === 0) return;
    this.round += 1;
    const round = this.round;
    const rights = await this.channelRights(wanted);
    for (const [socket, state] of this.sockets) {
      for (const [channel, followed] of state.channels) {
        if (followed.since >= round) continue;
        const hearing = rights
          .get(state.userId)
          ?.get(channel.slice("grid:".length));
        if (hearing) followed.hearing = hearing;
        else this.leave(socket, state, channel);
      }
    }
  }

  /** The socket no longer follows this channel: the others see it go. */
  private leave(socket: WebSocket, state: SocketState, channel: string): void {
    state.channels.delete(channel);
    this.unfollow(channel, socket);
    const name = channel.slice("grid:".length);
    this.transmit(socket, JSON.stringify({ type: "stale", channel: name }));
    this.bus
      .publish(
        channel,
        JSON.stringify({
          type: "presence",
          channel: name,
          userId: state.userId,
          name: state.name,
          gone: true,
        }),
      )
      .catch((error: unknown) => this.log("error", error, "realtime failed"));
  }

  /** What this account hears of a channel now; undefined if it may not. */
  private async hearingOf(
    userId: string,
    channel: string,
  ): Promise<ChannelHearing | undefined> {
    if (!this.channelRights) return "rows";
    const rights = await this.channelRights(
      new Map([[userId, new Set([channel])]]),
    );
    return rights.get(userId)?.get(channel);
  }

  /** Another process's sockets are told of a closing here. */
  private announceClosing(): void {
    void publishRightsChanged(this.bus, (error) => {
      this.log("error", error, "realtime failed");
    });
  }

  /** Beats every `everyMs` until the returned function stops it. */
  startHeartbeat(everyMs = BEAT_MS): () => void {
    const timer = setInterval(() => {
      this.beat();
      void this.recheck();
    }, everyMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  /**
   * Closes an account's sockets in this process once its sessions are
   * ended, and has the others look at theirs.
   */
  closeUser(userId: string): number {
    let closed = 0;
    for (const [socket, state] of this.sockets) {
      if (state.userId !== userId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.close(4401, "Unauthorized");
      closed += 1;
    }
    this.announceClosing();
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
    this.announceClosing();
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
    this.announceClosing();
    return closed;
  }

  private follow(channel: string, socket: WebSocket): void {
    const sockets = this.subscribers.get(channel) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.subscribers.set(channel, sockets);
  }

  private unfollow(channel: string, socket: WebSocket): void {
    const sockets = this.subscribers.get(channel);
    if (!sockets) return;
    sockets.delete(socket);
    // A channel nobody follows leaves no entry behind.
    if (sockets.size === 0) this.subscribers.delete(channel);
  }

  private async remove(socket: WebSocket, state: SocketState): Promise<void> {
    this.sockets.delete(socket);
    const open = (this.perAccount.get(state.userId) ?? 1) - 1;
    if (open > 0) this.perAccount.set(state.userId, open);
    else this.perAccount.delete(state.userId);
    for (const channel of state.channels.keys()) {
      this.unfollow(channel, socket);
    }
    for (const channel of state.channels.keys()) {
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

  /** A message from a page, run under what its kind asks. */
  private onDeclared(
    socket: WebSocket,
    state: SocketState,
    raw: string,
  ): Promise<void> {
    const kind = messageKind(raw);
    return runDeclared(
      `ws.${kind ?? "invalid"}`,
      kind ? MESSAGE_ASKS[kind] : { exception: "socket" },
      () => this.onClient(socket, state, raw),
      (message) =>
        this.log("warn", new Error(message), "undeclared permission"),
    );
  }

  private async onClient(
    socket: WebSocket,
    state: SocketState,
    raw: string,
  ): Promise<void> {
    if (!this.sockets.has(socket) || socket.readyState !== socket.OPEN) {
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed) {
      this.transmit(
        socket,
        JSON.stringify({ type: "error", message: "Invalid message" }),
      );
      return;
    }
    // Leaving a channel asks for no right, and works with the database down.
    if (parsed.type === "unsubscribe") {
      const left = gridChannel(parsed.channel);
      state.channels.delete(left);
      this.unfollow(left, socket);
      return;
    }
    // Before anything is asked of the database: this one is a hint, and
    // the page says it again within seconds.
    if (parsed.type === "presence" && !this.mayTellPresence(state)) {
      return;
    }
    // Read before the checks: a change of rights heard after this may
    // not be in what they answer.
    const heardBefore = this.rightsHeard;
    if (state.sessionTokenHash && this.sessionIdentities) {
      try {
        const identity = (
          await this.sessionIdentities([state.sessionTokenHash])
        ).get(state.sessionTokenHash);
        if (identity !== state.userId) {
          closeForIdentity(socket, identity);
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
        parsed.type === "lock" ? "rows.write" : "rows.read",
      );
    } catch (error) {
      this.log("error", error, "realtime failed");
      this.reject(socket);
      return;
    }
    if (decision !== "ok") {
      this.log(
        "warn",
        undefined,
        decision === "enroll" ? "mfa enrollment required" : "access denied",
      );
      // Refused a read: it no longer follows the channel either. A lock
      // asks to write, which says nothing of what it may read.
      if (parsed.type !== "lock") {
        const followed = gridChannel(parsed.channel);
        if (state.channels.has(followed)) {
          this.leave(socket, state, followed);
        }
      }
      this.reject(socket);
      return;
    }
    try {
      const channel = gridChannel(parsed.channel);
      if (parsed.type === "subscribe") {
        if (
          !state.channels.has(channel) &&
          state.channels.size >= MAX_CHANNELS_PER_SOCKET
        ) {
          this.reject(socket);
          return;
        }
        const hearing = await this.hearingOf(state.userId, parsed.channel);
        if (!hearing) {
          this.reject(socket);
          return;
        }
        state.channels.set(channel, { hearing, since: this.round });
        this.follow(channel, socket);
        this.transmit(
          socket,
          JSON.stringify({ type: "subscribed", channel: parsed.channel }),
        );
        // Rights changed while this was being answered: ask again now.
        if (heardBefore !== this.rightsHeard) void this.recheck();
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
      // Every other message type returned above: this is a cell lock. It
      // names a row and a field, which a rule may keep from this reader.
      if ((await this.hearingOf(state.userId, parsed.channel)) !== "rows") {
        this.reject(socket);
        return;
      }
      const acquired = await acquireLock(this.db, {
        key: cellLockKey(parsed.channel, parsed.rowId, parsed.column),
        owner: state.userId,
        ttlSeconds: 30,
      });
      await this.bus.publish(channel, JSON.stringify({ ...parsed, acquired }));
    } catch (error) {
      this.log("error", error, "realtime failed");
      this.reject(socket);
    }
  }

  private reject(socket: WebSocket): void {
    this.transmit(
      socket,
      JSON.stringify({ type: "error", message: "Request rejected" }),
    );
  }

  /** A burst as someone moves across cells, then a few a second. */
  private mayTellPresence(state: SocketState): boolean {
    const now = Date.now();
    state.presenceTokens = Math.min(
      PRESENCE_BURST,
      state.presenceTokens +
        ((now - state.presenceAt) / 1000) * PRESENCE_PER_SECOND,
    );
    state.presenceAt = now;
    if (state.presenceTokens < 1) return false;
    state.presenceTokens -= 1;
    return true;
  }
}
