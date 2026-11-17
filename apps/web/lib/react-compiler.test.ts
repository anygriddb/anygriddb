import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { expect, it } from "vitest";

// The React Compiler keeps what a component computes from one render to
// the next. A component or a hook it cannot follow is left as written, and
// the build says nothing: a `finally` clause added to a component is
// enough. Where a component holds no `useMemo` of its own, counting on
// the compiler, that silence would cost every render.
//
// This compiles the app's sources as the build does and compares what the
// compiler leaves out with the list kept beside this file. A name that is
// not listed: the change made the compiler give a component up (the
// message says why); rewrite it, or list it if it must stay. A name
// listed that now compiles: take it off the list, which only gets shorter.

const WEB = fileURLToPath(new URL("..", import.meta.url));
const LIST = fileURLToPath(
  new URL("react-compiler-left-out.txt", import.meta.url),
);

/** The app's own sources, tests aside. */
function sources(folder: string, found: string[] = []): string[] {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** The components and hooks of a file the compiler leaves out, and why. */
async function leftOut(file: string): Promise<Map<string, string>> {
  const events: LoggerEvent[] = [];
  await transformAsync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: {
      plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    },
    // The build's own order (vite.config.ts): messages, then the compiler.
    plugins: [
      "@lingui/babel-plugin-lingui-macro",
      [
        "babel-plugin-react-compiler",
        {
          logger: {
            logEvent: (_file: string | null, event: LoggerEvent) =>
              events.push(event),
          },
        },
      ],
    ],
  });
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "CompileError") continue;
    const line = event.fnLoc?.start.line ?? 0;
    // A function the compiler could not name is told by where it starts.
    const source = readFileSync(file, "utf8").split("\n")[line - 1] ?? "";
    const name =
      /(?:function|const)\s+([A-Za-z0-9_]+)/.exec(source)?.[1] ??
      `line ${String(line)}`;
    names.set(name, event.detail.reason);
  }
  return names;
}

it("compiles every component and hook but those listed", async () => {
  const found = new Map<string, string>();
  for (const folder of ["app", "components", "lib"]) {
    for (const file of sources(join(WEB, folder))) {
      for (const [name, reason] of await leftOut(file)) {
        found.set(`${relative(WEB, file)} ${name}`, reason);
      }
    }
  }
  const listed = readFileSync(LIST, "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  // Given up since: each with the compiler's reason.
  expect(
    [...found]
      .filter(([entry]) => !listed.includes(entry))
      .map(([entry, reason]) => `${entry}: ${reason}`),
  ).toEqual([]);
  // Compiled since: the list is out of date.
  expect(listed.filter((entry) => !found.has(entry))).toEqual([]);
}, 120_000);
