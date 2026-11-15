import type { CopySourceEngine } from "@anygriddb/core";
import { cassandra } from "./cassandra.js";
import { mongodb } from "./mongodb.js";
import { neo4jStore } from "./neo4j.js";
import { opensearch } from "./opensearch.js";
import { redis } from "./redis.js";
import type { CopyConnector } from "./types.js";

export type {
  CopyConnector,
  CopyRequest,
  CopyRow,
  CopyValue,
} from "./types.js";

const CONNECTORS: Record<CopySourceEngine, CopyConnector> = {
  mongodb,
  opensearch,
  redis,
  cassandra,
  neo4j: neo4jStore,
};

/** How AnyGridDB reads a store that speaks no SQL (ADR 0088). */
export function copyConnector(engine: CopySourceEngine): CopyConnector {
  return CONNECTORS[engine];
}
