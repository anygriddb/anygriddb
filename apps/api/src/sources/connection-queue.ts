import { AppError } from "@anygriddb/core";

/** How a queue opens, checks, and closes one engine's connections. */
type ConnectionHooks<C> = {
  open: () => Promise<C>;
  /** False once the server or the driver has dropped the connection. */
  usable: (connection: C) => boolean;
  close: (connection: C) => Promise<void> | void;
};

type ConnectionQueue<C> = {
  acquire: () => Promise<C>;
  /** Gives a connection back; a broken one is closed and its place handed on. */
  release: (connection: C, broken: boolean) => void;
  /** Forgets an idle connection the server ended. */
  drop: (connection: C) => void;
  /** Turns away the ones waiting and closes the idle connections. */
  end: () => Promise<void>;
};

/**
 * How long a read waits for a free connection, as a PostgreSQL source's
 * pool does (`connectionTimeoutMillis`): past it, the source is busy.
 */
const QUEUE_WAIT_MS = 10_000;

/**
 * At most `limit` connections to one source, kept idle between uses, for
 * drivers without a pool of their own. Callers past the limit wait in
 * turn, at most `waitMs`: a source whose connections are all held does
 * not pile up requests that wait for ever. A place freed by a broken
 * connection, or by one that failed to open, goes to the next one waiting
 * on a connection of its own: no one waits for a connection that will
 * never come back.
 */
export function connectionQueue<C>(
  limit: number,
  hooks: ConnectionHooks<C>,
  waitMs = QUEUE_WAIT_MS,
): ConnectionQueue<C> {
  const idle: C[] = [];
  const waiting: Array<{
    resolve: (connection: C) => void;
    reject: (error: Error) => void;
  }> = [];
  let open = 0;
  let ended = false;

  async function connect(): Promise<C> {
    open += 1;
    try {
      return await hooks.open();
    } catch (error) {
      open -= 1;
      handOn();
      throw error;
    }
  }
  function handOn(): void {
    const next = waiting.shift();
    if (next) connect().then(next.resolve, next.reject);
  }
  function discard(connection: C): Promise<void> {
    open -= 1;
    return Promise.resolve(hooks.close(connection));
  }

  return {
    acquire() {
      if (ended) return Promise.reject(new AppError("source_unreachable"));
      for (let ready = idle.pop(); ready !== undefined; ready = idle.pop()) {
        if (hooks.usable(ready)) return Promise.resolve(ready);
        void discard(ready);
      }
      if (open >= limit) {
        if (waiting.length >= limit) {
          return Promise.reject(new AppError("source_timeout"));
        }
        return new Promise((resolve, reject) => {
          const waiter = {
            resolve: (connection: C) => {
              clearTimeout(timer);
              resolve(connection);
            },
            reject: (error: Error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          const timer = setTimeout(() => {
            const at = waiting.indexOf(waiter);
            if (at >= 0) waiting.splice(at, 1);
            reject(new AppError("source_timeout"));
          }, waitMs);
          waiting.push(waiter);
        });
      }
      return connect();
    },
    release(connection, broken) {
      if (!broken && !ended && hooks.usable(connection)) {
        const next = waiting.shift();
        if (next) next.resolve(connection);
        else idle.push(connection);
        return;
      }
      void discard(connection);
      handOn();
    },
    drop(connection) {
      const at = idle.indexOf(connection);
      if (at < 0) return;
      idle.splice(at, 1);
      open -= 1;
    },
    async end() {
      ended = true;
      for (const waiter of waiting.splice(0)) {
        waiter.reject(new AppError("source_unreachable"));
      }
      await Promise.all(idle.splice(0).map(discard));
    },
  };
}
