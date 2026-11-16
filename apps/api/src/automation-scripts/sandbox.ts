import { type ChildProcess, fork } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * What one script may use before it is stopped (ADR 0099). The time
 * counts the instance's answers too; the memory is the interpreter's,
 * and the process around it has a heap of its own to carry the answers.
 */
export const SCRIPT_LIMITS = {
  timeMs: 10_000,
  /** What the scripts of one automation run may take together. */
  runMs: 60_000,
  memoryBytes: 32 * 1024 * 1024,
  /** Reads and writes one script may ask for. */
  maxCalls: 100,
  /** What one call may carry to the instance. */
  maxCallBytes: 256 * 1024,
  /** What the instance may answer to one call. */
  maxReplyBytes: 4 * 1024 * 1024,
  /** What a script may hand to the actions after it. */
  maxOutputBytes: 64 * 1024,
  /** The heap of the process the interpreter lives in. */
  heapMb: 128,
  /** How long that process may take to start. */
  startMs: 10_000,
  /** How long past a script's time its process is left before it is ended. */
  graceMs: 2_000,
} as const;

export type ScriptLimits = { [Key in keyof typeof SCRIPT_LIMITS]: number };

/**
 * Scripts one API process runs at once: each has a process and a heap
 * of its own, so the others wait their turn rather than add to them.
 */
export const SCRIPTS_AT_ONCE = 4;

let running = 0;
const waiting: Array<() => void> = [];

/** Waits for a turn; the answer gives it back, once. */
async function takeTurn(): Promise<() => void> {
  if (running >= SCRIPTS_AT_ONCE) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running += 1;
  }
  let given = false;
  return () => {
    if (given) return;
    given = true;
    // The turn passes to whoever waited longest, or is free again.
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
}

/** Why a script did not answer: its own error, or a ceiling it reached. */
export type ScriptFailureKind = "error" | "timeout" | "memory" | "stopped";

/** A script that failed: words its author can read, and what it logged. */
export class ScriptFailure extends Error {
  constructor(
    readonly kind: ScriptFailureKind,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message);
    this.name = "ScriptFailure";
  }
}

/**
 * Does what a script asks of the instance, by name, with what it sent:
 * the caller checks every value, the script is never trusted. What it
 * returns goes back as JSON; what it throws goes back as `refusal`'s
 * words.
 */
export type ScriptHost = (name: string, args: unknown) => Promise<unknown>;

const logsSchema = z.array(z.string().max(1_000)).max(100);

/** What the script's process may say: nothing else is read. */
const outgoingSchema = z.union([
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("call"),
      call: z.int().min(1),
      name: z.string().max(100),
      args: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      ok: z.literal(true),
      output: z.string(),
      logs: logsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      ok: z.literal(false),
      kind: z.enum(["error", "timeout", "memory"]),
      message: z.string().max(1_000),
      logs: logsSchema,
    })
    .strict(),
]);

type Outgoing = z.infer<typeof outgoingSchema>;

/** From sources Node runs the TypeScript itself; in the bundle, a file beside it. */
function runnerEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts")
    ? join(dirname(here), "runner.ts")
    : join(dirname(here), "script-runner.js");
}

/**
 * The only folders the script's process may read: its own code, and the
 * packages it imports, where the installer keeps them. Nothing else of
 * the disk, and nothing to write.
 */
function readablePaths(entry: string): string[] {
  let root = dirname(entry);
  while (!existsSync(join(root, "node_modules")) && dirname(root) !== root) {
    root = dirname(root);
  }
  const modules = join(root, "node_modules");
  const paths = new Set([dirname(entry), modules, join(root, "package.json")]);
  const real = realpathSync(join(modules, "quickjs-emscripten-core"));
  const marker = `${sep}node_modules${sep}`;
  const at = real.indexOf(marker);
  if (at >= 0) paths.add(real.slice(0, at + marker.length - 1));
  return [...paths];
}

/**
 * How the script's process is started: Node's permission model on, with
 * leave to read its own code and nothing else granted, and a heap of its
 * own.
 */
export function scriptProcess(limits: Pick<ScriptLimits, "heapMb">): {
  entry: string;
  execArgv: string[];
} {
  const entry = runnerEntry();
  return {
    entry,
    execArgv: [
      "--permission",
      ...readablePaths(entry).map((path) => `--allow-fs-read=${path}`),
      `--max-old-space-size=${String(limits.heapMb)}`,
    ],
  };
}

type Pending = {
  host: ScriptHost;
  refusal: (error: unknown) => string;
  resolve: (result: ScriptResult) => void;
  reject: (failure: ScriptFailure) => void;
  timer?: NodeJS.Timeout;
  /** When the script was handed to its process. */
  startedAt?: number;
  /** Gives the script's turn back. */
  release?: () => void;
  /** The calls already taken, one after the other. */
  queue: Promise<void>;
};

/** The script's process: ready once it has loaded its interpreter. */
type Started = {
  child: ChildProcess;
  ready: Promise<void>;
  /** Ends it, whatever it was doing. */
  stop: () => void;
};

export type ScriptResult = { output: unknown; logs: string[] };

const stopped = () => new ScriptFailure("stopped", "Script stopped");

/**
 * A process for the scripts of one automation run, started with the
 * first script and stopped by `close`. The scripts share the run's time
 * as well as the process. It is given no environment, may
 * read its own code and nothing else, and may open no file to write, no
 * connection, no other process: what a script does to the instance, it
 * asks through `host`.
 */
export class ScriptRunner {
  private started: Started | undefined;
  private pending: Pending | undefined;
  /** The time this run's scripts have taken so far. */
  private usedMs = 0;

  constructor(private readonly limits: ScriptLimits = SCRIPT_LIMITS) {}

  /** Runs `code` with `input`; one script at a time. */
  run(
    code: string,
    input: unknown,
    host: ScriptHost,
    refusal: (error: unknown) => string = () => "Refused",
  ): Promise<ScriptResult> {
    if (this.pending) return Promise.reject(stopped());
    if (this.usedMs >= this.limits.runMs) {
      return Promise.reject(
        new ScriptFailure("timeout", "Script took too long"),
      );
    }
    return new Promise<ScriptResult>((resolve, reject) => {
      const pending: Pending = {
        host,
        refusal,
        resolve,
        reject,
        queue: Promise.resolve(),
      };
      this.pending = pending;
      const { limits } = this;
      const begin = (child: ChildProcess) => {
        if (this.pending !== pending) return;
        // A script has its own time, within what is left of its run's.
        const timeMs = Math.min(limits.timeMs, limits.runMs - this.usedMs);
        if (timeMs <= 0) {
          this.settle(new ScriptFailure("timeout", "Script took too long"));
          return;
        }
        pending.startedAt = Date.now();
        // The interpreter stops itself at the limit; this stops a
        // process that no longer listens.
        pending.timer = setTimeout(() => {
          this.fail(new ScriptFailure("timeout", "Script took too long"));
        }, timeMs + limits.graceMs);
        child.send({
          type: "run",
          code,
          input: JSON.stringify(input ?? null),
          limits: {
            timeMs,
            memoryBytes: limits.memoryBytes,
            maxCalls: limits.maxCalls,
            maxCallBytes: limits.maxCallBytes,
            maxOutputBytes: limits.maxOutputBytes,
          },
        });
      };
      void takeTurn().then((release) => {
        // Stopped while it waited: the turn goes to the next.
        if (this.pending !== pending) {
          release();
          return;
        }
        pending.release = release;
        // A process that cannot start, or went away before it was
        // asked, ends the script as one that stopped.
        const refused = () => {
          if (this.pending === pending) this.fail(stopped());
        };
        this.start().then(begin).catch(refused);
      });
    });
  }

  /** Stops the process, whatever it was doing. */
  close(): void {
    this.fail(stopped());
  }

  /** The process, started when there is none, once it is ready. */
  private async start(): Promise<ChildProcess> {
    const running = this.started ?? this.spawn();
    await running.ready;
    return running.child;
  }

  private spawn(): Started {
    const { entry, execArgv } = scriptProcess(this.limits);
    const child = fork(entry, [], {
      execArgv,
      // Nothing of the instance: no address, no key, no path.
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    let refuse: (failure: ScriptFailure) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      refuse = reject;
      child.on("message", (raw: unknown) => {
        const message = outgoingSchema.safeParse(raw);
        if (!message.success) {
          this.fail(stopped());
        } else if (message.data.type === "ready") {
          resolve();
        } else {
          this.receive(message.data);
        }
      });
    });
    const timer = setTimeout(() => {
      if (this.started === started) this.fail(stopped());
    }, this.limits.startMs);
    // A start that fails is told to the script that waited for it.
    ready.then(
      () => clearTimeout(timer),
      () => undefined,
    );
    const started: Started = {
      child,
      ready,
      stop: () => {
        clearTimeout(timer);
        refuse(stopped());
        child.removeAllListeners();
        // The process has no say in its own end.
        child.kill("SIGKILL");
      },
    };
    // Out of memory, or a crash of the interpreter.
    const gone = () => {
      if (this.started === started) this.fail(stopped());
    };
    child.once("error", gone);
    child.once("exit", gone);
    this.started = started;
    return started;
  }

  private receive(message: Exclude<Outgoing, { type: "ready" }>): void {
    const pending = this.pending;
    if (!pending) return;
    if (message.type === "call") {
      pending.queue = pending.queue.then(() => this.answer(pending, message));
      return;
    }
    // What the script asked before it ended is done before its answer counts.
    void pending.queue.then(() => {
      if (this.pending !== pending) return;
      if (!message.ok) {
        // A script that failed ends its run: its process ends with it,
        // whatever state the interpreter was left in.
        this.fail(
          new ScriptFailure(message.kind, message.message, message.logs),
        );
        return;
      }
      let output: unknown;
      try {
        output = JSON.parse(message.output);
      } catch {
        this.fail(stopped());
        return;
      }
      this.settle({ output, logs: message.logs });
    });
  }

  /** One call of the script, done by the host, and its answer sent back. */
  private async answer(
    pending: Pending,
    message: Extract<Outgoing, { type: "call" }>,
  ): Promise<void> {
    if (this.pending !== pending) return;
    let reply: { ok: boolean; value: string };
    try {
      const args: unknown = JSON.parse(message.args);
      const value = JSON.stringify(
        (await pending.host(message.name, args)) ?? null,
      );
      reply =
        Buffer.byteLength(value) > this.limits.maxReplyBytes
          ? { ok: false, value: "Answer too large" }
          : { ok: true, value };
    } catch (error) {
      reply = { ok: false, value: pending.refusal(error).slice(0, 300) };
    }
    const child = this.started?.child;
    if (this.pending !== pending || !child?.connected) return;
    child.send({ type: "reply", call: message.call, ...reply });
  }

  /** Ends the script in flight, the process staying for the next one. */
  private settle(outcome: ScriptResult | ScriptFailure): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.startedAt !== undefined) {
      this.usedMs += Date.now() - pending.startedAt;
    }
    pending.release?.();
    if (outcome instanceof ScriptFailure) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  /** Ends the script in flight and the process with it. */
  private fail(failure: ScriptFailure): void {
    const started = this.started;
    this.started = undefined;
    this.settle(failure);
    started?.stop();
  }
}
