import { createServer, type Socket } from "node:net";

export type ReceivedMail = { from: string; to: string[]; data: string };

/**
 * A mail server on the loopback, for tests: it speaks just enough SMTP for
 * nodemailer, offers no STARTTLS (a relay on this machine may skip it, as
 * `sendMail` allows), and keeps what it receives.
 */
export async function fakeSmtp() {
  const received: ReceivedMail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let current: ReceivedMail = { from: "", to: [], data: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 localhost test");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: "", to: [], data: "" };
          reply("250 queued");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") {
          reply("250-localhost");
          reply("250 8BITMIME");
        } else if (verb === "HELO") reply("250 localhost");
        else if (verb === "MAIL") {
          current.from = line.replace(/^MAIL FROM:\s*/i, "");
          reply("250 OK");
        } else if (verb === "RCPT") {
          current.to.push(line.replace(/^RCPT TO:\s*<?([^>\s]*)>?.*$/i, "$1"));
          reply("250 OK");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 go on");
        } else if (verb === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("250 OK");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  /** The next mail to `to` that arrives, waiting up to a few seconds. */
  async function next(to: string, timeoutMs = 5_000): Promise<ReceivedMail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = received.findIndex((mail) => mail.to.includes(to));
      if (index >= 0) return received.splice(index, 1)[0] as ReceivedMail;
      if (Date.now() > deadline) throw new Error(`no mail to ${to}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function close(): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { port, received, next, close };
}

/**
 * A received mail as text: the encoded words of its headers and its
 * quoted-printable body decoded as UTF-8, soft breaks undone. A subject
 * with any character beyond ASCII travels as an encoded word.
 */
export function mailText(mail: ReceivedMail): string {
  const bytes = mail.data
    // A long subject is folded into several encoded words: one text.
    .replace(/\?=\r\n[ \t]+=\?UTF-8\?Q\?/gi, "")
    .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_match, word: string) =>
      word.replaceAll("_", " "),
    )
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  return Buffer.from(bytes, "latin1").toString("utf8");
}
