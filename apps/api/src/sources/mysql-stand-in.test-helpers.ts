import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { TLSSocket } from "node:tls";

const PROTOCOL_41 = 0x200;
const SSL = 0x800;
const SECURE_CONNECTION = 0x8000;
const PLUGIN_AUTH = 0x80000;
const CONNECT_WITH_DB = 0x8;
const CAPABILITIES =
  PROTOCOL_41 | SSL | SECURE_CONNECTION | PLUGIN_AUTH | CONNECT_WITH_DB;
const PLUGIN = "caching_sha2_password";
const SCRAMBLE = Buffer.alloc(20, 0x61);

function packet(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

function greeting(): Buffer {
  const low = Buffer.alloc(2);
  low.writeUInt16LE(CAPABILITIES & 0xffff);
  const high = Buffer.alloc(2);
  high.writeUInt16LE(CAPABILITIES >>> 16);
  return packet(
    0,
    Buffer.concat([
      Buffer.from([0x0a]),
      Buffer.from("8.4.0\0"),
      Buffer.alloc(4, 1),
      SCRAMBLE.subarray(0, 8),
      Buffer.from([0]),
      low,
      Buffer.from([45, 2, 0]),
      high,
      Buffer.from([21]),
      Buffer.alloc(10),
      SCRAMBLE.subarray(8),
      Buffer.from([0]),
      Buffer.from(`${PLUGIN}\0`),
    ]),
  );
}

/** What a client sends to ask for TLS, before its first TLS byte. */
const TLS_REQUEST_BYTES = 36;
const FULL_AUTHENTICATION = Buffer.from([0x01, 0x04]);
const DENIED = Buffer.concat([
  Buffer.from([0xff, 0x15, 0x04]),
  Buffer.from("#28000denied"),
]);

/** Splits what arrives into packets, whatever the chunks. */
function onPackets(
  stream: TLSSocket,
  handle: (sequence: number, payload: Buffer) => void,
): void {
  let pending = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUIntLE(0, 3);
      if (pending.length < 4 + length) return;
      const sequence = pending[3] ?? 0;
      const payload = pending.subarray(4, 4 + length);
      pending = pending.subarray(4 + length);
      handle(sequence, payload);
    }
  });
}

export type StandIn = {
  port: number;
  /** Everything the client wrote once TLS was up. */
  received: () => Buffer;
  close: () => Promise<void>;
};

/**
 * A server that speaks just enough of the protocol to ask a client for its
 * password in full over TLS, and keeps what it gets.
 */
export async function startStandIn(identity: {
  cert: string;
  key: string;
}): Promise<StandIn> {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write(greeting());
    let pending = Buffer.alloc(0);
    let tunnel: Duplex | undefined;
    socket.on("end", () => tunnel?.push(null));
    socket.on("close", () => tunnel?.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (tunnel) {
        tunnel.push(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < TLS_REQUEST_BYTES) return;
      tunnel = new Duplex({
        read: () => undefined,
        write: (data: Buffer, _encoding, done) => {
          socket.write(data, () => done());
        },
        final: (done) => {
          socket.end(() => done());
        },
      });
      tunnel.on("error", () => undefined);
      const secure = new TLSSocket(tunnel, { isServer: true, ...identity });
      secure.on("error", () => undefined);
      secure.on("data", (data: Buffer) => chunks.push(Buffer.from(data)));
      onPackets(secure, (sequence) => {
        if (sequence === 2) secure.write(packet(3, FULL_AUTHENTICATION));
        if (sequence === 4) secure.end(packet(5, DENIED));
      });
      tunnel.push(pending.subarray(TLS_REQUEST_BYTES));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The stand-in server has no port");
  }
  return {
    port: address.port,
    received: () => Buffer.concat(chunks),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
