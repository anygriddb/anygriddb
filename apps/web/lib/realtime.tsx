import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Connection,
  type ServerMessage,
  type Subscriber,
} from "./realtime-connection";
import { socketUrl, useTRPC } from "./trpc";
const ConnectionContext = createContext<Connection | null>(null);

/**
 * The page's realtime connection (ADR 0049), opened while `enabled`. It
 * reconnects at once when the network comes back or the tab is shown.
 */
export function RealtimeProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const api = useTRPC();
  // The session ended elsewhere: reading it again sends the page to sign-in.
  const onUnauthorized = useEffectEvent(() => {
    void queryClient.invalidateQueries({
      queryKey: api.session.current.queryKey(),
    });
  });
  const [connection] = useState(
    () =>
      new Connection({
        url: socketUrl,
        open: (url) => new WebSocket(url),
      }),
  );
  useEffect(() => {
    if (!enabled) return;
    const offUnauthorized = connection.onUnauthorized(() => {
      onUnauthorized();
    });
    connection.start();
    const wake = () => {
      connection.wake();
    };
    const shown = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", shown);
      offUnauthorized();
      connection.stop();
    };
  }, [connection, enabled]);
  return (
    <ConnectionContext.Provider value={connection}>
      {children}
    </ConnectionContext.Provider>
  );
}

/**
 * Follows a channel (table, base, or account id) while mounted. `resync`
 * says how to re-read everything shown from it: realtime messages are
 * hints, and some may be lost (ADR 0049).
 */
export function useChannel(
  channel: string | undefined,
  handlers: Subscriber,
): void {
  const connection = useContext(ConnectionContext);
  // The latest handlers, without subscribing again each time they change.
  const onMessage = useEffectEvent((message: ServerMessage) => {
    handlers.message(message);
  });
  const onResync = useEffectEvent(() => {
    handlers.resync();
  });
  useEffect(() => {
    if (!connection || !channel) return;
    return connection.subscribe(channel, {
      message: (message) => {
        onMessage(message);
      },
      resync: () => {
        onResync();
      },
    });
  }, [connection, channel]);
}

function useSocketSend(): (message: Record<string, unknown>) => void {
  const connection = useContext(ConnectionContext);
  return useMemo(() => (message) => connection?.send(message), [connection]);
}

const noDownChange = () => () => undefined;

/** True once the page has had no realtime link for a while. */
export function useConnectionDown(): boolean {
  const connection = useContext(ConnectionContext);
  return useSyncExternalStore(
    connection ? (listener) => connection.onDownChange(listener) : noDownChange,
    () => connection?.isDown() ?? false,
  );
}

/** Opens a link now, without waiting for the next try. */
export function useReconnect(): () => void {
  const connection = useContext(ConnectionContext);
  return useCallback(() => {
    connection?.reconnect();
  }, [connection]);
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
  const { viewId, rowId, column } = mine;
  useChannel(channel, {
    message: (message) => {
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
    },
    // Back after a gap: say where this person is now, not in 15 s.
    resync: () => {
      if (channel) send({ type: "presence", channel, viewId, rowId, column });
    },
  });
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
