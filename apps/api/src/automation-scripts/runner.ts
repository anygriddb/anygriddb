/**
 * The process a script of an automation runs in (ADR 0099). It holds
 * nothing of the instance: no environment, no database, no network, no
 * file but its own code. The script itself runs one level further in, in
 * a QuickJS interpreter compiled to WebAssembly, where it sees the
 * language and three names: `input`, `records`, `console`. Whatever it
 * asks of the instance crosses to the API process as text, and is done
 * there with its author's rights.
 *
 * This file imports nothing of the product, so that Node runs it as it
 * is, from the sources as from the bundle.
 */
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

/** What the API process sends. */
type Incoming =
  | {
      type: "run";
      code: string;
      /** JSON: what the script reads as `input`. */
      input: string;
      limits: {
        timeMs: number;
        memoryBytes: number;
        maxCalls: number;
        maxCallBytes: number;
        maxOutputBytes: number;
      };
    }
  /** The answer to a call: JSON when `ok`, the refusal's words otherwise. */
  | { type: "reply"; call: number; ok: boolean; value: string };

/** What this process sends back. */
type Outgoing =
  | { type: "ready" }
  | { type: "call"; call: number; name: string; args: string }
  | { type: "done"; ok: true; output: string; logs: string[] }
  | {
      type: "done";
      ok: false;
      kind: "error" | "timeout" | "memory";
      message: string;
      logs: string[];
    };

const MAX_LOG_LINES = 50;
const MAX_LOG_LENGTH = 500;
const MAX_ERROR_LENGTH = 300;
const STACK_BYTES = 512 * 1024;

/**
 * Inside the interpreter, before the script: `records` and `console`
 * over the two functions the host gives, and the script's answer as
 * JSON. Values cross as text both ways, so no object of one side is ever
 * held by the other.
 */
const PRELUDE = `(function (hostCall, hostLog, inputJson, script) {
  "use strict";
  const call = async (name, args) =>
    JSON.parse(await hostCall(name, JSON.stringify(args)));
  const records = Object.freeze({
    list: (table, query) => call("records.list", { table, query }),
    get: (table, id) => call("records.get", { table, id }),
    create: (table, fields) => call("records.create", { table, fields }),
    update: (table, id, fields) =>
      call("records.update", { table, id, fields }),
    delete: (table, id) => call("records.delete", { table, id }),
  });
  const text = (value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const say = (...values) => hostLog(values.map(text).join(" "));
  const console = Object.freeze({
    log: say, info: say, warn: say, error: say, debug: say,
  });
  return (async () => {
    const result = await script(JSON.parse(inputJson), records, console);
    return result === undefined ? "null" : JSON.stringify(result) ?? "null";
  })();
})`;

function send(message: Outgoing): void {
  process.send?.(message);
}

/** A thrown value of the interpreter, as words for the script's author. */
function describe(context: QuickJSContext, error: QuickJSHandle): string {
  const dumped: unknown = context.dump(error);
  if (dumped && typeof dumped === "object") {
    const { name, message, stack } = dumped as Record<string, unknown>;
    const line =
      typeof stack === "string"
        ? /script\.js:(\d+)/.exec(stack)?.[1]
        : undefined;
    const said = `${typeof name === "string" ? name : "Error"}: ${
      typeof message === "string" ? message : ""
    }`;
    return (line ? `${said} (line ${line})` : said).slice(0, MAX_ERROR_LENGTH);
  }
  return String(dumped).slice(0, MAX_ERROR_LENGTH);
}

type Failure = { kind: "error" | "timeout" | "memory"; message: string };

function failureOf(message: string): Failure {
  if (message.startsWith("InternalError: interrupted")) {
    return { kind: "timeout", message: "Script took too long" };
  }
  if (message.startsWith("InternalError: out of memory")) {
    return { kind: "memory", message: "Script used too much memory" };
  }
  return { kind: "error", message };
}

type Engine = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

/** One script, in an interpreter of its own, until it answers or fails. */
class Run {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly logs: string[] = [];
  private readonly waiting = new Map<
    number,
    ReturnType<QuickJSContext["newPromise"]>
  >();
  private readonly task: Extract<Incoming, { type: "run" }>;
  private calls = 0;
  private finished = false;
  private settle: (() => void) | undefined;

  // Written without parameter properties: Node runs this file from the
  // sources by erasing its types, and those are not erasable.
  constructor(engine: Engine, task: Extract<Incoming, { type: "run" }>) {
    this.task = task;
    this.runtime = engine.newRuntime();
    this.runtime.setMemoryLimit(task.limits.memoryBytes);
    this.runtime.setMaxStackSize(STACK_BYTES);
    // The time counts from here, the instance's answers included.
    const deadline = Date.now() + task.limits.timeMs;
    this.runtime.setInterruptHandler(() => Date.now() > deadline);
    this.context = this.runtime.newContext();
  }

  /** Runs the script; resolves once `done` was sent. */
  async start(): Promise<void> {
    const { context } = this;
    const compiled = context.evalCode(
      `(async function (input, records, console) {${this.task.code}\n})`,
      "script.js",
    );
    if (compiled.error) {
      this.fail(describe(context, compiled.error));
      compiled.error.dispose();
      return;
    }
    const prelude = context.unwrapResult(context.evalCode(PRELUDE));
    const hostCall = context.newFunction("call", (name, args) =>
      this.call(context.getString(name), context.getString(args)),
    );
    const hostLog = context.newFunction("log", (text) => {
      if (this.logs.length < MAX_LOG_LINES) {
        this.logs.push(context.getString(text).slice(0, MAX_LOG_LENGTH));
      }
    });
    const input = context.newString(this.task.input);
    const started = context.callFunction(
      prelude,
      context.undefined,
      hostCall,
      hostLog,
      input,
      compiled.value,
    );
    for (const handle of [prelude, hostCall, hostLog, input, compiled.value]) {
      handle.dispose();
    }
    if (started.error) {
      this.fail(describe(context, started.error));
      started.error.dispose();
      return;
    }
    const done = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    void context.resolvePromise(started.value).then((result) => {
      started.value.dispose();
      if (result.error) {
        this.fail(describe(context, result.error));
        result.error.dispose();
        return;
      }
      const output = context.getString(result.value);
      result.value.dispose();
      if (Buffer.byteLength(output) > this.task.limits.maxOutputBytes) {
        this.fail("Error: The script's result is too large");
        return;
      }
      this.finish({ type: "done", ok: true, output, logs: this.logs });
    });
    this.pump();
    await done;
  }

  /** The answer to a call the script made. */
  reply(message: Extract<Incoming, { type: "reply" }>): void {
    const deferred = this.waiting.get(message.call);
    if (!deferred || this.finished) return;
    this.waiting.delete(message.call);
    const { context } = this;
    if (message.ok) {
      const value = context.newString(message.value);
      deferred.resolve(value);
      value.dispose();
    } else {
      const error = context.newError(message.value);
      deferred.reject(error);
      error.dispose();
    }
    this.pump();
  }

  /** Frees the interpreter. */
  dispose(): void {
    try {
      for (const deferred of this.waiting.values()) deferred.dispose();
      this.waiting.clear();
      this.context.dispose();
      this.runtime.dispose();
    } catch {
      // A script that was cut short leaves handles behind: the API
      // process ends this one after a failure, so nothing is kept long.
    }
  }

  /** A call to the instance: a promise the reply settles. */
  private call(name: string, args: string): QuickJSHandle {
    const { context } = this;
    const deferred = context.newPromise();
    const refuse = (message: string) => {
      const error = context.newError(message);
      deferred.reject(error);
      error.dispose();
    };
    if (this.calls >= this.task.limits.maxCalls) {
      refuse("Too many calls");
    } else if (Buffer.byteLength(args) > this.task.limits.maxCallBytes) {
      refuse("Too much sent in one call");
    } else {
      this.calls += 1;
      this.waiting.set(this.calls, deferred);
      send({ type: "call", call: this.calls, name, args });
    }
    return deferred.handle;
  }

  /**
   * Lets the script go on until it waits again. A script that waits for
   * nothing the instance owes it will never end: it fails now.
   */
  private pump(): void {
    if (this.finished) return;
    const jobs = this.runtime.executePendingJobs();
    if (jobs.error) {
      this.fail(describe(this.context, jobs.error));
      jobs.error.dispose();
      return;
    }
    // The script's own answer settles in a later turn of this process.
    setImmediate(() => {
      if (this.finished || this.waiting.size > 0) return;
      if (this.runtime.hasPendingJob()) {
        this.pump();
        return;
      }
      this.fail("Error: The script waits for something that never comes");
    });
  }

  private fail(message: string): void {
    this.finish({
      type: "done",
      ok: false,
      ...failureOf(message),
      logs: this.logs,
    });
  }

  private finish(message: Outgoing): void {
    if (this.finished) return;
    this.finished = true;
    send(message);
    this.settle?.();
  }
}

/**
 * The interpreter's whole memory, given a ceiling it cannot grow past.
 * QuickJS has a limit of its own, set for each script, but as it is
 * built here it counts allocations rather than their size: many strings
 * of a megabyte pass under it. This one counts bytes, whatever asked for
 * them, and a script that reaches it is refused the memory and fails.
 */
const PAGE_BYTES = 64 * 1024;
const START_PAGES = 256;
const ceiling = Number(process.argv[2]);
// Node has WebAssembly, but the types this package is checked with do
// not describe it: what makes a memory is named here, and the memory is
// handed on as the library's own type.
type MemoryLimits = { initial: number; maximum: number };
const { Memory } = (
  globalThis as unknown as {
    WebAssembly: { Memory: new (limits: MemoryLimits) => object };
  }
).WebAssembly;
const memory = new Memory({
  initial: START_PAGES,
  maximum: Math.max(
    START_PAGES,
    Math.floor((Number.isFinite(ceiling) ? ceiling : 0) / PAGE_BYTES),
  ),
});
const engine = await newQuickJSWASMModuleFromVariant(
  newVariant(variant, { wasmMemory: memory as never }),
);
let current: Run | undefined;

process.on("message", (message: Incoming) => {
  if (message.type === "reply") {
    current?.reply(message);
    return;
  }
  const run = new Run(engine, message);
  current = run;
  void run.start().then(() => {
    current = undefined;
    run.dispose();
  });
});
// The API process went away: nothing is left to answer to.
process.on("disconnect", () => process.exit(0));
send({ type: "ready" });
