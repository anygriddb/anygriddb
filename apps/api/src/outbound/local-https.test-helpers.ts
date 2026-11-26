/**
 * A local HTTPS listener a test of the outbound service reaches as if it
 * were a public host: the call claims a public address, and the agent
 * dials this port.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { Agent, createServer, type Server } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { issueAuthority, issueServer } from "../tls/certificate.js";

export const HOST = "hooks.example.org";
const PUBLIC = "203.0.113.10";

/** An authority and a leaf for the name the call uses. */
function certificates() {
  const authority = issueAuthority({
    commonName: "AnyGridDB outbound test",
    names: [HOST],
  });
  const leaf = issueServer({
    names: [HOST],
    authority: {
      cert: authority.cert,
      key: createPrivateKey(authority.key),
      publicKey: new X509Certificate(authority.cert).publicKey,
      commonName: "AnyGridDB outbound test",
    },
  });
  return { authority, leaf };
}

const servers: Server[] = [];

/** Closes the listeners a test opened: its `afterEach`. */
export function closeLocalHttps(): void {
  for (const server of servers.splice(0)) server.close();
}

/**
 * A local HTTPS listener the production lookup would never reach: the
 * call claims a public address, and `createConnection` dials this port.
 */
export async function localHttps(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<{ port: number; ca: string }> {
  const { authority, leaf } = certificates();
  const server = createServer(
    { key: leaf.key, cert: leaf.cert + authority.cert },
    handler,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: authority.cert,
  };
}

export const publicLookup: LookupFunction = (_hostname, options, callback) => {
  const list = [{ address: PUBLIC, family: 4 }];
  if (typeof options === "object" && options.all) {
    callback(null, list);
    return;
  }
  callback(null, PUBLIC, 4);
};

/**
 * An agent that dials the local listener over TLS. Lookup still claims a
 * public address so the SSRF gate passes; the socket never leaves the
 * machine.
 */
export function pinAgent(port: number, ca: string): Agent {
  const agent = new Agent({
    lookup: publicLookup,
    ca,
    maxCachedSessions: 0,
  });
  const dial: typeof agent.createConnection = (_options, callback) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: HOST,
      ca,
      rejectUnauthorized: true,
    });
    if (callback) {
      socket.once("secureConnect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, socket));
    }
    return socket;
  };
  agent.createConnection = dial;
  return agent;
}

export const resolvePublic = () =>
  Promise.resolve([{ address: PUBLIC, family: 4 }]);
