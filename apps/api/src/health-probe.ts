/**
 * `anygriddb health`: whether the API on this machine answers, over HTTPS
 * with its certificate verified (ADR 0029). The probe reaches the loopback
 * but checks the certificate for the name people open (`PUBLIC_URL`),
 * which is the one an operator's certificate is sure to carry; a lapsed or
 * wrong certificate reads as unhealthy.
 */
import { readFile } from "node:fs/promises";
import { get } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { checkServerIdentity, rootCertificates } from "node:tls";

type HealthProbe = {
  port: number;
  /** The name the certificate must cover: PUBLIC_URL's host. */
  host: string;
  /** Authorities that may vouch for it. */
  ca: readonly string[];
};

/** The host people open, from PUBLIC_URL. */
export function publicHost(env: NodeJS.ProcessEnv, port: number): string {
  const url = new URL(env.PUBLIC_URL || `https://localhost:${String(port)}`);
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * The system's authorities, the instance's own (TLS_DIR), and the
 * operator's certificate chain (TLS_CERT_FILE), whichever exist.
 */
export async function healthAuthorities(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const files = [
    join(env.TLS_DIR || "./data/tls", "authority.crt"),
    ...(env.TLS_CERT_FILE ? [env.TLS_CERT_FILE] : []),
  ];
  const found = await Promise.all(
    files.map((file) => readFile(file, "utf8").catch(() => null)),
  );
  return [
    ...rootCertificates,
    ...found.filter((pem): pem is string => pem !== null),
  ];
}

/** 0 when `/health` answers 200 over a verified connection, 1 otherwise. */
export function probeHealth(probe: HealthProbe): Promise<number> {
  return new Promise((resolve) => {
    const request = get(
      {
        host: "127.0.0.1",
        port: probe.port,
        path: "/health",
        ca: [...probe.ca],
        // SNI takes a name, never an address.
        ...(isIP(probe.host) === 0 ? { servername: probe.host } : {}),
        checkServerIdentity: (_loopback, certificate) =>
          checkServerIdentity(probe.host, certificate),
        timeout: 4_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200 ? 0 : 1);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => {
      resolve(1);
    });
  });
}
