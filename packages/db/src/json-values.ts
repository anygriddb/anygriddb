import {
  OperationNodeTransformer,
  PrimitiveValueListNode,
  ValueNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";

/** Arrays and plain objects: the values a `jsonb` column takes. */
function isJsonDocument(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encode(value: unknown): unknown {
  return isJsonDocument(value) ? JSON.stringify(value) : value;
}

/**
 * `pg` sends a JavaScript array as a PostgreSQL array, which a `jsonb`
 * column refuses. The catalog has no array columns, so every array or
 * plain object written by an insert or an update is a JSON document:
 * this sends it as JSON text, which PostgreSQL casts to `jsonb`.
 *
 * Filters keep their arrays: `= any($1)` needs a PostgreSQL array.
 */
class JsonValues extends OperationNodeTransformer {
  #writing = 0;

  protected override transformInsertQuery(
    node: Parameters<OperationNodeTransformer["transformInsertQuery"]>[0],
  ) {
    this.#writing += 1;
    try {
      return super.transformInsertQuery(node);
    } finally {
      this.#writing -= 1;
    }
  }

  protected override transformColumnUpdate(
    node: Parameters<OperationNodeTransformer["transformColumnUpdate"]>[0],
  ) {
    this.#writing += 1;
    try {
      return super.transformColumnUpdate(node);
    } finally {
      this.#writing -= 1;
    }
  }

  protected override transformWhere(
    node: Parameters<OperationNodeTransformer["transformWhere"]>[0],
  ) {
    // A filter inside an insert (`on conflict … where`) is not a write.
    const writing = this.#writing;
    this.#writing = 0;
    try {
      return super.transformWhere(node);
    } finally {
      this.#writing = writing;
    }
  }

  protected override transformValue(node: ValueNode): ValueNode {
    if (this.#writing === 0 || !isJsonDocument(node.value)) {
      return super.transformValue(node);
    }
    return ValueNode.create(encode(node.value));
  }

  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
  ): PrimitiveValueListNode {
    if (this.#writing === 0) return super.transformPrimitiveValueList(node);
    return PrimitiveValueListNode.create(node.values.map(encode));
  }
}

export class JsonValuesPlugin implements KyselyPlugin {
  readonly #transformer = new JsonValues();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node);
  }

  transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
