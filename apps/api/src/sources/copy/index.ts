import type { CopySourceEngine } from "@anygriddb/core";
import { mongodb } from "./mongodb.js";
import { opensearch } from "./opensearch.js";
import type { CopyConnector } from "./types.js";

export type { CopyConnector, CopyRequest, CopyRow } from "./types.js";

const CONNECTORS: Record<CopySourceEngine, CopyConnector> = {
  mongodb,
  opensearch,
};

/** How AnyGridDB reads a store that speaks no SQL (ADR 0088). */
export function copyConnector(engine: CopySourceEngine): CopyConnector {
  return CONNECTORS[engine];
}
