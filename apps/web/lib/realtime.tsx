import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useEffectEvent,
  useState,
  type ReactNode,
} from "react";
import { socketUrl } from "./trpc";

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
        | "subscribed"
        | "error";
      channel?: string;
    };

type Listener = (message: ServerMessage) => void;

class Socket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly statusListeners = new Set<(online: boolean) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  online = false;

  start(): void {
    this.closed = false;
    // On the next tick: a start undone at once (Strict Mode mounts twice)
    // then opens no socket at all.
    this.timer = setTimeout(() => this.connect(), 0);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed || typeof window === "undefined") {
      return;
    }
    const socket = new WebSocket(socketUrl());
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.setOnline(true);
      for (const channel of this.listeners.keys()) {
        this.send({ type: "subscribe", channel });
      }
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      const channel = "channel" in message ? message.channel : undefined;
      if (!channel) return;
      for (const listener of this.listeners.get(channel) ?? []) {
        listener(message);
      }
    };
    socket.onclose = () => {
      this.setOnline(false);
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry);
      this.retry += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private setOnline(value: boolean): void {
    this.online = value;
    for (const listener of this.statusListeners) listener(value);
  }

  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.send({ type: "subscribe", channel });
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(channel);
        this.send({ type: "unsubscribe", channel });
      }
    };
  }

  onStatus(listener: (online: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}

const SocketContext = createContext<Socket | null>(null);

export function RealtimeProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const socket = useMemo(() => new Socket(), []);
  useEffect(() => {
    if (!enabled) return;
    socket.start();
    return () => socket.stop();
  }, [socket, enabled]);
  return (
    <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
  );
}

/** Subscribes to a channel (table or base id) for as long as the component is mounted. */
export function useChannel(
  channel: string | undefined,
  listener: Listener,
): void {
  const socket = useContext(SocketContext);
  // The latest listener, without subscribing again each time it changes.
  const onMessage = useEffectEvent(listener);
  useEffect(() => {
    if (!socket || !channel) return;
    return socket.subscribe(channel, (message) => {
      onMessage(message);
    });
  }, [socket, channel]);
}

export function useSocketSend(): (message: Record<string, unknown>) => void {
  const socket = useContext(SocketContext);
  return useMemo(() => (message) => socket?.send(message), [socket]);
}

export function useOnline(): boolean {
  const socket = useContext(SocketContext);
  const [online, setOnline] = useState(socket?.online ?? false);
  useEffect(() => (socket ? socket.onStatus(setOnline) : undefined), [socket]);
  return online;
}

export type Presence = {
  userId: string;
  name: string;
  viewId?: string;
  rowId?: string;
  column?: string;
  seen: number;
};

/** Who else is on a table, refreshed by a heartbeat and expired after 40 s. */
export function usePresence(
  channel: string | undefined,
  selfId: string | undefined,
  mine: { viewId?: string; rowId?: string; column?: string },
): Presence[] {
  const send = useSocketSend();
  const [peers, setPeers] = useState<Map<string, Presence>>(new Map());
  useChannel(channel, (message) => {
    if (message.type !== "presence" || message.userId === selfId) return;
    setPeers((current) => {
      const next = new Map(current);
      if (message.gone) {
        next.delete(message.userId);
      } else {
        next.set(message.userId, {
          userId: message.userId,
          name: message.name,
          viewId: message.viewId,
          rowId: message.rowId,
          column: message.column,
          seen: Date.now(),
        });
      }
      return next;
    });
  });
  const { viewId, rowId, column } = mine;
  useEffect(() => {
    if (!channel) return;
    const beat = () =>
      send({ type: "presence", channel, viewId, rowId, column });
    beat();
    const timer = setInterval(beat, 15_000);
    return () => clearInterval(timer);
  }, [channel, viewId, rowId, column, send]);
  useEffect(() => {
    const timer = setInterval(() => {
      setPeers((current) => {
        const cutoff = Date.now() - 40_000;
        const next = new Map(
          [...current].filter(([, peer]) => peer.seen > cutoff),
        );
        return next.size === current.size ? current : next;
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, []);
  return [...peers.values()];
}
