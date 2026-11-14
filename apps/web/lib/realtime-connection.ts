/**
 * The page's one realtime connection (ADRs 0009, 0049).
 *
 * Its messages are hints ("these rows changed"); the truth is what a page
 * reads. So after any gap in the stream, every subscriber re-reads what it
 * shows (`resync`):
 * - when a channel is subscribed again on a new connection, at the
 *   server's `subscribed` and not before, or a change made in between
 *   would be missed;
 * - when the server says it lost messages itself (`stale`).
 *
 * "Open" means something: the server beats every 25 s, and a link silent
 * for longer than `silentMs` is dead, closed, and opened again. The
 * network coming back, or the tab shown again, reconnects at once. After
 * `downAfterMs` without an open link, the page says so.
 */

export type ServerMessage =
  | {
      type: "rows";
      channel: string;
      op: "insert" | "update" | "delete" | "refresh";
      rowIds: string[];
    }
  | { type: "stale"; channel: string }
  | { type: "catalog"; channel: string }
  | { type: "notification"; channel: string }
  | {
      type: "job";
      channel: string;
      jobId: string;
      kind:
        | "import"
        | "export"
        | "duplicate_table"
        | "trash_purge"
        | "export_snapshot"
        | "import_snapshot";
      status: "queued" | "running" | "done" | "failed" | "cancelled";
      done: number;
      total: number | null;
    }
  | {
      type: "presence";
      channel: string;
      userId: string;
      name: string;
      viewId?: string;
      rowId?: string;
      column?: string;
      gone?: boolean;
    }
  | {
      type:
        | "patch"
        | "refresh"
        | "delete"
        | "lock"
        | "hello"
        | "beat"
        | "subscribed"
        | "error";
      channel?: string;
    };

export type Subscriber = {
  message: (message: ServerMessage) => void;
  /** Re-read everything shown from this channel: messages may be lost. */
  resync: () => void;
};

type ConnectionSettings = {
  url: () => string;
  open: (url: string) => WebSocket;
  /** Without an open link this long, the page says so. */
  downAfterMs?: number;
  /** A link that says nothing this long is dead. */
  silentMs?: number;
  /** 0 to 1, for the jitter of reconnections. */
  random?: () => number;
};

const OPEN = 1;
const UNAUTHORIZED = 4401;
const MAX_RETRY_MS = 30_000;

type Channel = {
  subscribers: Set<Subscriber>;
  /** A link was lost while it was wanted: re-read once subscribed again. */
  resyncOnAck: boolean;
};

export class Connection {
  private link: WebSocket | null = null;
  /** Links closed or failed so far: none on a page that loaded fine. */
  private losses = 0;
  private readonly channels = new Map<string, Channel>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private heardAt = 0;
  private down = false;
  private stopped = true;
  private readonly downListeners = new Set<() => void>();
  private readonly unauthorizedListeners = new Set<() => void>();
  private readonly downAfterMs: number;
  private readonly silentMs: number;
  private readonly random: () => number;

  constructor(private readonly settings: ConnectionSettings) {
    this.downAfterMs = settings.downAfterMs ?? 10_000;
    this.silentMs = settings.silentMs ?? 65_000;
    this.random = settings.random ?? Math.random;
  }

  start(): void {
    this.stopped = false;
    this.armDown();
    // On the next tick: a start undone at once (Strict Mode mounts twice)
    // then opens no link at all.
    this.retryTimer = setTimeout(() => {
      this.connect();
    }, 0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const link = this.link;
    this.link = null;
    link?.close();
    this.setDown(false);
  }

  /** The network is back or the tab is shown: check the link now. */
  wake(): void {
    if (this.stopped) return;
    if (this.link?.readyState === OPEN) {
      if (Date.now() - this.heardAt > this.silentMs) this.drop();
      return;
    }
    if (this.link) return;
    this.reconnect();
  }

  /** Opens a link now, without waiting for the next try. */
  reconnect(): void {
    if (this.stopped || this.link) return;
    this.retry = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  isDown(): boolean {
    return this.down;
  }

  onDownChange(listener: () => void): () => void {
    this.downListeners.add(listener);
    return () => {
      this.downListeners.delete(listener);
    };
  }

  /** The server closed the link because the session is over. */
  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.add(listener);
    return () => {
      this.unauthorizedListeners.delete(listener);
    };
  }

  send(message: Record<string, unknown>): void {
    if (this.link?.readyState === OPEN) {
      this.link.send(JSON.stringify(message));
    }
  }

  subscribe(name: string, subscriber: Subscriber): () => void {
    let channel = this.channels.get(name);
    if (!channel) {
      // Added while cut off: what it reads now may change before the link
      // is back. On a page still loading, the first link is not a loss.
      channel = {
        subscribers: new Set(),
        resyncOnAck: this.losses > 0 && this.link?.readyState !== OPEN,
      };
      this.channels.set(name, channel);
      this.send({ type: "subscribe", channel: name });
    }
    channel.subscribers.add(subscriber);
    return () => {
      const current = this.channels.get(name);
      current?.subscribers.delete(subscriber);
      if (current && current.subscribers.size === 0) {
        this.channels.delete(name);
        this.send({ type: "unsubscribe", channel: name });
      }
    };
  }

  private connect(): void {
    this.retryTimer = null;
    if (this.stopped) return;
    const link = this.settings.open(this.settings.url());
    this.link = link;
    link.onopen = () => {
      if (this.link !== link) return;
      this.retry = 0;
      this.heard();
      if (this.downTimer) clearTimeout(this.downTimer);
      this.downTimer = null;
      this.setDown(false);
      for (const name of this.channels.keys()) {
        this.send({ type: "subscribe", channel: name });
      }
    };
    link.onmessage = (event) => {
      if (this.link !== link) return;
      this.heard();
      this.deliver(event.data);
    };
    link.onclose = (event) => {
      this.lost(link, event.code);
    };
  }

  /** The link closed, failed to open, or went silent: try again later. */
  private lost(link: WebSocket, code: number): void {
    if (this.link !== link) return;
    this.link = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.stopped) return;
    this.losses += 1;
    for (const channel of this.channels.values()) channel.resyncOnAck = true;
    if (code === UNAUTHORIZED) {
      for (const listener of [...this.unauthorizedListeners]) listener();
    }
    this.armDown();
    const delay = Math.min(MAX_RETRY_MS, 500 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = setTimeout(
      () => {
        this.connect();
      },
      delay * (0.8 + 0.4 * this.random()),
    );
  }

  private deliver(data: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    const name = "channel" in message ? message.channel : undefined;
    if (!name) return;
    const channel = this.channels.get(name);
    if (!channel) return;
    if (message.type === "subscribed") {
      // Live again from here: what happened while the link was lost is
      // read now, not before, or a change made in between would be missed.
      if (channel.resyncOnAck) {
        channel.resyncOnAck = false;
        for (const subscriber of [...channel.subscribers]) subscriber.resync();
      }
      return;
    }
    if (message.type === "stale") {
      for (const subscriber of [...channel.subscribers]) subscriber.resync();
      return;
    }
    for (const subscriber of [...channel.subscribers]) {
      subscriber.message(message);
    }
  }

  /** Something came in: the link is alive for another `silentMs`. */
  private heard(): void {
    this.heardAt = Date.now();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.drop();
    }, this.silentMs);
  }

  /**
   * A link that went silent is closed here. A dead link may never report
   * its close, so it is counted lost now, and the next one opens at once.
   */
  private drop(): void {
    const link = this.link;
    if (!link) return;
    this.retry = 0;
    link.close();
    this.lost(link, 1006);
  }

  /** Says the page is cut off if no link opens within `downAfterMs`. */
  private armDown(): void {
    if (this.downTimer || this.down) return;
    this.downTimer = setTimeout(() => {
      this.downTimer = null;
      this.setDown(true);
    }, this.downAfterMs);
  }

  private setDown(down: boolean): void {
    if (this.down === down) return;
    this.down = down;
    for (const listener of [...this.downListeners]) listener();
  }

  private clearTimers(): void {
    for (const timer of [this.retryTimer, this.silenceTimer, this.downTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.retryTimer = null;
    this.silenceTimer = null;
    this.downTimer = null;
  }
}
