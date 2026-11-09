import type { Binding } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { Bus } from "../realtime/bus.js";
import type { SessionUser } from "../auth/session.js";
import type { TokenScope } from "../auth/tokens.js";

export const MAX_RECORDS = 100;

export type PublicApiDeps = {
  db: Database;
  bus: Bus;
  publicUrl: string;
  log: (error: unknown, message: string) => void;
};

/** Who calls: a person, and the token's scope when a token was used. */
export type Actor = {
  user: SessionUser;
  bindings: Binding[];
  scope?: TokenScope;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
