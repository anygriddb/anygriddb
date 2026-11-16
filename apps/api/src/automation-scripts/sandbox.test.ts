import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCRIPT_LIMITS,
  SCRIPTS_AT_ONCE,
  ScriptFailure,
  type ScriptHost,
  type ScriptLimits,
  scriptProcess,
  ScriptRunner,
} from "./sandbox.js";

// Each test starts a process or several: on a busy machine that takes
// longer than a test usually may.
vi.setConfig({ testTimeout: 30_000 });

const runners: ScriptRunner[] = [];

function runner(limits: Partial<ScriptLimits> = {}): ScriptRunner {
  const made = new ScriptRunner({ ...SCRIPT_LIMITS, ...limits });
  runners.push(made);
  return made;
}

const noHost: ScriptHost = () => Promise.reject(new Error("no host"));

/** The failure a script ends with. */
async function failure(run: Promise<unknown>): Promise<ScriptFailure> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ScriptFailure) return error;
    throw error;
  }
  throw new Error("The script did not fail");
}

afterEach(() => {
  for (const made of runners.splice(0)) made.close();
});

describe("what a script answers", () => {
  it("returns its result and what it logged", async () => {
    const result = await runner().run(
      `console.log("hello", { a: 1 }); return { total: input.a + input.b };`,
      { a: 2, b: 3 },
      noHost,
    );
    expect(result).toEqual({ output: { total: 5 }, logs: ['hello {"a":1}'] });
  });

  it("answers nothing when it returns nothing", async () => {
    const result = await runner().run(`const unused = 1;`, {}, noHost);
    expect(result.output).toBeNull();
  });

  it("asks the instance, and reads its answer", async () => {
    const asked: Array<{ name: string; args: unknown }> = [];
    const host: ScriptHost = (name, args) => {
      asked.push({ name, args });
      return Promise.resolve({ records: [{ id: "r1", fields: { n: 2 } }] });
    };
    const result = await runner().run(
      `const page = await records.list("Orders", { limit: 5 });
       const made = await records.create("Orders", { n: page.records[0].fields.n * 2 });
       return { made };`,
      {},
      host,
    );
    expect(asked).toEqual([
      { name: "records.list", args: { table: "Orders", query: { limit: 5 } } },
      { name: "records.create", args: { table: "Orders", fields: { n: 4 } } },
    ]);
    expect(result.output).toEqual({
      made: { records: [{ id: "r1", fields: { n: 2 } }] },
    });
  });

  it("gives a refusal to the script as an error it may catch", async () => {
    const host: ScriptHost = () => Promise.reject(new Error("secret detail"));
    const result = await runner().run(
      `try { await records.get("Orders", "x"); } catch (error) { return error.message; }`,
      {},
      host,
      () => "Access denied",
    );
    expect(result.output).toBe("Access denied");
  });

  it("finishes what the script asked for before its answer counts", async () => {
    const done: string[] = [];
    const host: ScriptHost = async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      done.push(name);
      return null;
    };
    await runner().run(`records.delete("Orders", "x"); return 1;`, {}, host);
    expect(done).toEqual(["records.delete"]);
  });

  it("runs the scripts of one run in turn, each in a world of its own", async () => {
    const one = runner();
    await one.run(
      `globalThis.kept = 1; Object.prototype.kept = 1;`,
      {},
      noHost,
    );
    const second = await one.run(
      `return [typeof globalThis.kept, typeof ({}).kept];`,
      {},
      noHost,
    );
    expect(second.output).toEqual(["undefined", "undefined"]);
  });
});

describe("what a script cannot do", () => {
  it("sees the language, and nothing of the process it runs in", async () => {
    const result = await runner().run(
      `return [typeof process, typeof require, typeof fetch, typeof setTimeout,
               typeof WebAssembly, typeof globalThis.module, typeof Deno];`,
      {},
      noHost,
    );
    expect(result.output).toEqual(Array.from({ length: 7 }, () => "undefined"));
  });

  it("reaches no function of the host through the ones it is given", async () => {
    const result = await runner().run(
      `const made = records.list.constructor("return typeof process")();
       const viaError = (() => { try { null.x } catch (error) { return typeof error.constructor.constructor("return this")().process } })();
       return [made, viaError];`,
      {},
      noHost,
    );
    expect(result.output).toEqual(["undefined", "undefined"]);
  });

  it("is told where its own error is", async () => {
    const thrown = await failure(
      runner().run(`const a = 1;\nthrow new Error("boom");`, {}, noHost),
    );
    expect(thrown.kind).toBe("error");
    expect(thrown.message).toBe("Error: boom (line 2)");
  });

  it("is refused when it is not JavaScript", async () => {
    const thrown = await failure(runner().run(`return ((;`, {}, noHost));
    expect(thrown.kind).toBe("error");
    expect(thrown.message).toMatch(/^SyntaxError: /);
  });

  it("is stopped when it never ends", async () => {
    const thrown = await failure(
      runner({ timeMs: 300 }).run(
        `console.log("before"); while (true) {}`,
        {},
        noHost,
      ),
    );
    expect(thrown.kind).toBe("timeout");
    expect(thrown.message).toBe("Script took too long");
    expect(thrown.logs).toEqual(["before"]);
  });

  it("is stopped when it never ends after an answer", async () => {
    const thrown = await failure(
      runner({ timeMs: 300 }).run(
        `await records.get("Orders", "x"); while (true) {}`,
        {},
        () => Promise.resolve(null),
      ),
    );
    expect(thrown.kind).toBe("timeout");
  });

  it("is stopped by a pattern that never ends", async () => {
    const thrown = await failure(
      runner({ timeMs: 300 }).run(
        `return /^(a+)+$/.test("a".repeat(40) + "!");`,
        {},
        noHost,
      ),
    );
    expect(thrown.kind).toBe("timeout");
  });

  it.each([
    [
      "many large strings",
      `const kept = []; while (true) kept.push("x".repeat(512 * 1024) + kept.length);`,
    ],
    [
      "many small arrays",
      `const kept = []; while (true) kept.push(new Array(1000).fill("x"));`,
    ],
    [
      "many objects",
      `const kept = []; while (true) kept.push({ at: kept.length, text: "x" });`,
    ],
    ["one array too large", `return new Array(50_000_000).fill(1).length;`],
    ["bytes", `return new Uint8Array(256 * 1024 * 1024).length;`],
  ])(
    "is stopped when it takes more memory than it may: %s",
    async (_, code) => {
      const started = Date.now();
      const thrown = await failure(
        runner({ memoryBytes: 24 * 1024 * 1024 }).run(code, {}, noHost),
      );
      // Refused the memory, not left to run until its time is up.
      expect(thrown.kind).toBe("memory");
      expect(thrown.message).toBe("Script used too much memory");
      expect(Date.now() - started).toBeLessThan(SCRIPT_LIMITS.timeMs);
    },
  );

  it("is refused a text longer than the interpreter makes", async () => {
    const started = Date.now();
    const thrown = await failure(
      runner().run(
        `let text = "x".repeat(1024); while (true) text += text;`,
        {},
        noHost,
      ),
    );
    expect(thrown.kind).not.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(SCRIPT_LIMITS.timeMs);
  });

  it("is stopped when the instance takes too long to answer", async () => {
    const thrown = await failure(
      runner({ timeMs: 200, graceMs: 200 }).run(
        `await records.get("Orders", "x");`,
        {},
        () => new Promise(() => undefined),
      ),
    );
    expect(thrown.kind).toBe("timeout");
  });

  it("fails at once when it waits for nothing that will come", async () => {
    const started = Date.now();
    const thrown = await failure(
      runner().run(`await new Promise(() => {});`, {}, noHost),
    );
    expect(thrown.kind).toBe("error");
    expect(thrown.message).toMatch(/never comes/);
    // Long before its time is up.
    expect(Date.now() - started).toBeLessThan(SCRIPT_LIMITS.timeMs);
  });

  it("asks the instance a bounded number of times", async () => {
    let asked = 0;
    const host: ScriptHost = () => {
      asked += 1;
      return Promise.resolve(null);
    };
    const result = await runner({ maxCalls: 3 }).run(
      `let refused = "";
       for (let i = 0; i < 5; i += 1) {
         try { await records.get("Orders", "x"); } catch (error) { refused = error.message; }
       }
       return refused;`,
      {},
      host,
    );
    expect(asked).toBe(3);
    expect(result.output).toBe("Too many calls");
  });

  it("sends a bounded amount in one call", async () => {
    const result = await runner({ maxCallBytes: 1_000 }).run(
      `try { await records.create("Orders", { text: "x".repeat(2000) }); }
       catch (error) { return error.message; }`,
      {},
      noHost,
    );
    expect(result.output).toBe("Too much sent in one call");
  });

  it("is answered a bounded amount", async () => {
    const result = await runner({ maxReplyBytes: 1_000 }).run(
      `try { await records.list("Orders"); } catch (error) { return error.message; }`,
      {},
      () => Promise.resolve({ text: "x".repeat(2_000) }),
    );
    expect(result.output).toBe("Answer too large");
  });

  it("hands on a bounded result", async () => {
    const thrown = await failure(
      runner({ maxOutputBytes: 1_000 }).run(
        `return "x".repeat(2000);`,
        {},
        noHost,
      ),
    );
    expect(thrown.message).toMatch(/too large/);
  });

  it("keeps a bounded log", async () => {
    const result = await runner().run(
      `for (let i = 0; i < 200; i += 1) console.log("x".repeat(2000));`,
      {},
      noHost,
    );
    expect(result.logs).toHaveLength(50);
    expect(result.logs[0]).toHaveLength(500);
  });

  it("is stopped with its process", async () => {
    const one = runner();
    const running = failure(one.run(`while (true) {}`, {}, noHost));
    one.close();
    expect((await running).kind).toBe("stopped");
  });
});

describe("the scripts of one run", () => {
  it("share the run's time: the last ones get what is left, then nothing", async () => {
    const one = runner({ timeMs: 5_000, runMs: 1_000 });
    const busy = `const end = Date.now() + 700; while (Date.now() < end) {} return "done";`;
    expect((await one.run(busy, {}, noHost)).output).toBe("done");
    // Less than its 700 ms are left: the same script is cut short.
    expect((await failure(one.run(busy, {}, noHost))).kind).toBe("timeout");
    // Nothing is left: no process is started for it.
    const started = Date.now();
    const last = await failure(one.run(`return 1;`, {}, noHost));
    expect(last.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("scripts of several runs", () => {
  it("run a few at once, the others waiting their turn", async () => {
    const total = SCRIPTS_AT_ONCE + 3;
    let inFlight = 0;
    let most = 0;
    let left = total;
    const held: Array<() => void> = [];
    // Each call is held until as many scripts as may run at once are
    // here, or until no other can come: were one too many let in, or one
    // too few, the count would say so or the test would never end.
    const host: ScriptHost = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (inFlight < Math.min(SCRIPTS_AT_ONCE, left)) {
        await new Promise<void>((resolve) => held.push(resolve));
      } else {
        for (const release of held.splice(0)) release();
      }
      inFlight -= 1;
      left -= 1;
      return null;
    };
    const results = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        runner().run(
          `await records.get("Orders", "x"); return input;`,
          index,
          host,
        ),
      ),
    );
    expect(results.map((result) => result.output)).toEqual(
      Array.from({ length: total }, (_, index) => index),
    );
    expect(most).toBe(SCRIPTS_AT_ONCE);
  });

  it("give their turn back when they are stopped while waiting", async () => {
    const busy = Array.from({ length: SCRIPTS_AT_ONCE }, () => runner());
    const held = busy.map((one) =>
      failure(one.run(`while (true) {}`, {}, noHost)),
    );
    const late = runner();
    const waited = failure(late.run(`return 1;`, {}, noHost));
    late.close();
    expect((await waited).kind).toBe("stopped");
    for (const one of busy) one.close();
    await Promise.all(held);
    // Every turn is free again.
    const after = await runner().run(`return "ran";`, {}, noHost);
    expect(after.output).toBe("ran");
  });
});

describe("the process a script runs in", () => {
  /** What Node itself may do when started as the script's process is. */
  async function probe(code: string): Promise<string> {
    const { execArgv } = scriptProcess(SCRIPT_LIMITS);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...execArgv, "--input-type=module", "--eval", code],
      { env: {} },
    );
    return stdout.trim();
  }

  const attempt = (body: string) => `
    try { ${body}; console.log("allowed"); }
    catch (error) { console.log(error.code ?? error.message); }`;

  it("reads no file outside its own code", async () => {
    expect(
      await probe(
        `import { readFileSync } from "node:fs";
         ${attempt(`readFileSync("/etc/hostname")`)}
         ${attempt(`readFileSync("/proc/self/environ")`)}`,
      ),
    ).toBe("ERR_ACCESS_DENIED\nERR_ACCESS_DENIED");
  });

  it("writes no file", async () => {
    expect(
      await probe(
        `import { writeFileSync } from "node:fs";
         ${attempt(`writeFileSync("/tmp/script-probe", "x")`)}`,
      ),
    ).toBe("ERR_ACCESS_DENIED");
  });

  it("starts no process and no thread", async () => {
    expect(
      await probe(
        `import { spawnSync } from "node:child_process";
         import { Worker } from "node:worker_threads";
         ${attempt(`spawnSync("ls")`)}
         ${attempt(`new Worker("1", { eval: true })`)}`,
      ),
    ).toBe("ERR_ACCESS_DENIED\nERR_ACCESS_DENIED");
  });

  it("opens no connection", async () => {
    expect(
      await probe(
        `import { connect } from "node:net";
         try {
           await new Promise((resolve, reject) => {
             connect(9, "127.0.0.1").once("connect", resolve).once("error", reject);
           });
           console.log("allowed");
         } catch (error) { console.log(error.code); }`,
      ),
    ).toBe("ERR_ACCESS_DENIED");
  });

  it("is given nothing of the instance's environment", async () => {
    process.env.SCRIPT_PROBE_SECRET = "secret";
    try {
      const one = runner();
      // The interpreter has no way to read it; the process around it has
      // nothing to read.
      const result = await one.run(`return typeof process;`, {}, noHost);
      expect(result.output).toBe("undefined");
      expect(await probe(`console.log(Object.keys(process.env).length)`)).toBe(
        "0",
      );
    } finally {
      delete process.env.SCRIPT_PROBE_SECRET;
    }
  });
});
