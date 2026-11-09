/**
 * One port, HTTPS only (ADR 0029). A browser that asks for `http://` on
 * it gets a redirect to `https://` and nothing else: no page, no cookie
 * (they are all `Secure`), no data. The first byte of a connection tells
 * them apart: a TLS handshake starts with 0x16, an HTTP request with a
 * letter.
 */
import type { Socket } from "node:net";
import type { Server } from "node:tls";

/** At most this much of a plain request is read to find its host. */
const HEAD_LIMIT = 8 * 1024;
/** A connection that says nothing for this long is closed. */
const SNIFF_TIMEOUT_MS = 10_000;

const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;
const TARGET = /^\/[\x21-\x7e]*$/;

/**
 * The response to a plain HTTP request: a permanent redirect to the same
 * host and path over HTTPS, or 400 when the request names no valid host.
 */
export function plainResponse(head: string): string {
  const [line = "", ...headers] = head.split("\r\n");
  const [, target = "/"] = line.split(" ");
  const host = headers
    .find((header) => /^host:/i.test(header))
    ?.slice(5)
    .trim();
  if (!host || !HOST.test(host) || !TARGET.test(target)) {
    return "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  }
  return `HTTP/1.1 308 Permanent Redirect\r\nLocation: https://${host}${target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}

function answerPlain(socket: Socket): void {
  let head = "";
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end === -1 && head.length < HEAD_LIMIT) return;
    socket.off("data", onData);
    socket.end(
      plainResponse(
        end === -1 ? head.slice(0, HEAD_LIMIT) : head.slice(0, end),
      ),
    );
  };
  socket.on("data", onData);
  socket.resume();
}

/**
 * Makes `server` answer plain HTTP on its own port with a redirect. Its
 * TLS handling stays as it was: the first byte is put back, and Node's TLS
 * socket reads it from there.
 */
export function redirectPlainHttp(server: Server): void {
  const handlers = server.listeners("connection") as Array<
    (socket: Socket) => void
  >;
  server.removeAllListeners("connection");
  server.on("connection", (socket: Socket) => {
    const ignore = () => undefined;
    socket.on("error", ignore);
    socket.setTimeout(SNIFF_TIMEOUT_MS, () => socket.destroy());
    const sniff = () => {
      const first = socket.read(1) as Buffer | null;
      if (first === null) {
        socket.once("readable", sniff);
        return;
      }
      socket.setTimeout(0);
      socket.unshift(first);
      if (first[0] === 0x16) {
        socket.off("error", ignore);
        for (const handler of handlers) handler.call(server, socket);
        return;
      }
      answerPlain(socket);
    };
    sniff();
  });
}
