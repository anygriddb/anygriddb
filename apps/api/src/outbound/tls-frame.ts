/**
 * One frame over TLS to a collector (syslog, RFC 5425), part of the
 * outbound service as every connection the instance opens: the
 * collector's certificate verified for its name against the system's
 * authorities and the operator's, the whole exchange under one time limit,
 * nothing sent in clear.
 */
import { isIP, type LookupFunction } from "node:net";
import { connect, rootCertificates } from "node:tls";

export type TlsCollector = { host: string; port: number; ca?: string };

export function sendTlsFrame(
  collector: TlsCollector,
  frame: string,
  timeoutMs: number,
  lookup?: LookupFunction,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: collector.host,
      port: collector.port,
      // The addresses checked are the ones it connects to.
      ...(lookup ? { lookup } : {}),
      // An address has no name to send; its certificate must list it.
      servername: isIP(collector.host) === 0 ? collector.host : undefined,
      ca: collector.ca ? [...rootCertificates, collector.ca] : undefined,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    // One limit for the whole exchange: a collector that accepts the
    // connection and then stops answering does not hold a worker.
    const timer = setTimeout(() => {
      fail(new Error("syslog collector timed out"));
    }, timeoutMs);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.end(frame);
    });
    socket.once("close", (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
  });
}
