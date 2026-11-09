/**
 * Realtime fan-out across API processes through PostgreSQL's LISTEN/NOTIFY
 * (ADR 0009). Messages carry ids only, never cell values: a tab re-reads
 * what changed with its own rights.
 *
 * - Every message goes on one PostgreSQL channel; each process keeps what
 *   its own sockets subscribed to.
 * - NOTIFY takes a global lock at commit. Messages published in the same
 *   tick are sent in one statement, so one commit carries them all.
 * - A message that would not fit NOTIFY's 8,000-byte payload is dropped
 *   and logged; publishers chunk their row ids well below that.
 * - The listening connection reconnects on its own. Messages sent while it
 *   was down are lost, so every subscribed tab is told to refresh.
 */
import pg from "pg";

const CHANNEL = "anygriddb_realtime";
export const MAX_PAYLOAD_BYTES = 7_900;

export type Publisher = {
  publish: (channel: string, message: string) => Promise<unknown>;
};

export type BusHandler = (channel: string, message: string) => void;

export interface Bus extends Publisher {
  /** Receives every message any process publishes. */
  onMessage(handler: BusHandler): void;
  /** Called after the listener reconnected, when messages may be lost. */
  onReconnect(handler: () => void): void;
  /** True while the listening connection is up, for the health page. */
  listening(): boolean;
  close(): Promise<void>;
}

type Log = (error: unknown, message: string) => void;

export class PgBus implements Bus {
  private readonly handlers: BusHandler[] = [];
  private readonly reconnectHandlers: Array<() => void> = [];
  private queue: string[] = [];
  private flushing: Promise<void> | undefined;
  private client: pg.Client | undefined;
  private connected = false;
  private closed = false;
  private retryMs = 1_000;

  constructor(
    private readonly pool: pg.Pool,
    private readonly connectionString: string,
    private readonly log: Log,
  ) {}

  /** Opens the listening connection. Publishing works without it. */
  async start(): Promise<void> {
    await this.listen(false);
  }

  private async listen(reconnecting: boolean): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (notice) => {
      if (notice.channel !== CHANNEL || !notice.payload) return;
      this.deliver(notice.payload);
    });
    const lost = (error?: Error) => {
      if (this.client !== client) return;
      this.connected = false;
      this.client = undefined;
      if (error) this.log(error, "realtime listener lost");
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on("error", lost);
    client.on("end", () => lost());
    await client.connect();
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.client = client;
    this.connected = true;
    this.retryMs = 1_000;
    if (reconnecting) {
      for (const handler of this.reconnectHandlers) handler();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    const timer = setTimeout(() => {
      this.listen(true).catch((error: unknown) => {
        this.log(error, "realtime listener reconnect failed");
        this.scheduleReconnect();
      });
    }, wait);
    timer.unref();
  }

  private deliver(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("c" in parsed) ||
      !("m" in parsed) ||
      typeof parsed.c !== "string" ||
      typeof parsed.m !== "string"
    ) {
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(parsed.c, parsed.m);
      } catch (error) {
        this.log(error, "realtime handler failed");
      }
    }
  }

  publish(channel: string, message: string): Promise<void> {
    const payload = JSON.stringify({ c: channel, m: message });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      this.log(undefined, "realtime message too large, dropped");
      return Promise.resolve();
    }
    this.queue.push(payload);
    this.flushing ??= new Promise<void>((resolve) => {
      setImmediate(() => {
        const batch = this.queue;
        this.queue = [];
        this.flushing = undefined;
        // One statement: one implicit transaction, one commit lock.
        this.pool
          .query(
            `select pg_notify('${CHANNEL}', p) from unnest($1::text[]) p`,
            [batch],
          )
          .catch((error: unknown) => {
            this.log(error, "realtime publish failed");
          })
          .finally(resolve);
      });
    });
    return this.flushing;
  }

  onMessage(handler: BusHandler): void {
    this.handlers.push(handler);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  listening(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flushing;
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    await client?.end().catch(() => undefined);
  }
}
