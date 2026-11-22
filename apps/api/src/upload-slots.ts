import type { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

/**
 * Uploads read at once by one process: an attachment, a file to import,
 * a base snapshot. Each is written to local disk as it arrives; past the
 * ceiling, one more is refused at once rather than queued, so a burst of
 * large files cannot fill the disk or hold every request open. One holder
 * (an account, a public form) gets a share of them, so that it cannot take
 * them all.
 */
export type UploadSlots = {
  /** A slot, or undefined when none is left; give it back once. */
  take(holder: string): (() => void) | undefined;
  /** Slots taken now. */
  readonly busy: number;
};

export function uploadSlots(
  ceiling: number,
  // Two at least: a slot is given back just after its answer, and someone
  // sending files one after another may already be on the next.
  perHolder: number = Math.min(ceiling, Math.max(2, Math.floor(ceiling / 4))),
): UploadSlots {
  let busy = 0;
  const held = new Map<string, number>();
  return {
    take(holder) {
      const own = held.get(holder) ?? 0;
      if (busy >= ceiling || own >= perHolder) return undefined;
      busy += 1;
      held.set(holder, own + 1);
      let given = false;
      return () => {
        if (given) return;
        given = true;
        busy -= 1;
        const left = (held.get(holder) ?? 1) - 1;
        if (left > 0) held.set(holder, left);
        else held.delete(holder);
      };
    },
    get busy() {
      return busy;
    },
  };
}

/** How long an upload may send nothing before its connection is closed. */
export const UPLOAD_IDLE_MS = 15_000;

/**
 * Closes the connection of an upload that stops sending, which gives its
 * slot back. Returns what to call once the body has arrived: what follows
 * (storing the file) sends nothing and must not count as silence.
 */
export function cutIdleUpload(
  request: Pick<IncomingMessage, "socket">,
  response: Pick<ServerResponse, "writableEnded">,
  idleMs: number = UPLOAD_IDLE_MS,
): () => void {
  const { socket } = request;
  // A request made in-process has no connection to watch.
  if (!(socket instanceof Socket)) return () => undefined;
  const onIdle = () => {
    socket.destroy();
  };
  socket.setTimeout(idleMs);
  socket.on("timeout", onIdle);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    socket.off("timeout", onIdle);
    // Once answered, the server's keep-alive owns this timer.
    if (!response.writableEnded) socket.setTimeout(0);
  };
}
