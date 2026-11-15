import type { CopySourceEngine } from "@anygriddb/core";
import { mongodb } from "./mongodb.js";
import type { CopyConnector } from "./types.js";

export type {
  CopyConnector,
  CopyRequest,
  CopyRow,
  CopyValue,
} from "./types.js";

const CONNECTORS: Record<CopySourceEngine, CopyConnector> = { mongodb };

/** How AnyGridDB reads a store that speaks no SQL (ADR 0088). */
export function copyConnector(engine: CopySourceEngine): CopyConnector {
  return CONNECTORS[engine];
}
