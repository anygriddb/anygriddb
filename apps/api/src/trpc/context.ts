import type { Database } from "@anygriddb/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Bus } from "../realtime/bus.js";
import type { TokenScope } from "../auth/tokens.js";
import type { Env } from "../env.js";
import type { FileStore } from "../files/index.js";
import type { TlsInfo } from "../server.js";
import type { SourceSettings } from "../sources/types.js";
import type { GridHub } from "../ws.js";

export type Context = {
  db: Database;
  bus: Bus;
  req: FastifyRequest;
  res: FastifyReply;
  env: Env;
  files: FileStore;
  /** This process's sockets, to close those of an account cut off. */
  hub: Pick<GridHub, "closeUser" | "closeAllBut">;
  /** The operator's rules for sources (ADR 0026). */
  sources: SourceSettings;
  /** The certificate served, as administrators see it; null in tests. */
  tls: () => TlsInfo | null;
  /** Set when the request authenticated with an API token. */
  tokenScope?: TokenScope;
};
