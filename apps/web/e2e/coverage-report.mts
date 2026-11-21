// The journeys' raw coverage brought back to the sources: the browser's
// through the build's source maps, the server's through c8. Run from
// apps/web by scripts/e2e.sh:  node e2e/coverage-report.mts <dir>
import { mergeProcessCovs, type ProcessCov } from "@bcoe/v8-coverage";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseAstAsync } from "vitest/node";
import { coverageTotals, type CoverageFile } from "../lib/journey-coverage.ts";

const [dirArgument] = process.argv.slice(2);
if (!dirArgument) throw new Error("usage: coverage-report.mts <dir>");
const dir = resolve(dirArgument);
const dist = resolve("dist");
const root = resolve("../..");

function filesIn(folder: string, extension: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(extension))
    .map((name) => `${folder}/${name}`);
}

async function browserCoverage(): Promise<Record<string, CoverageFile>> {
  const parts = filesIn(`${dir}/client-raw`, ".json").map(
    (file) => JSON.parse(readFileSync(file, "utf8")) as ProcessCov,
  );
  const out: Record<string, CoverageFile> = {};
  for (const script of mergeProcessCovs(parts).result) {
    const file = resolve(dist, `.${script.url}`);
    // A script of another build: its lines say nothing of these sources.
    if (!existsSync(file)) {
      throw new Error(`${script.url} is not in this build`);
    }
    // A chunk that only re-exports another has no map and no source.
    if (!existsSync(`${file}.map`)) {
      console.log(`No source map, left out: ${script.url}`);
      continue;
    }
    const code = readFileSync(file, "utf8");
    const sourceMap = JSON.parse(readFileSync(`${file}.map`, "utf8")) as {
      sources: string[];
      sourceRoot?: string;
    };
    sourceMap.sources = sourceMap.sources.map((source) =>
      resolve(dirname(file), sourceMap.sourceRoot ?? "", source),
    );
    const data = (await astV8ToIstanbul({
      code,
      sourceMap: sourceMap as never,
      ast: await parseAstAsync(code),
      coverage: { functions: script.functions, url: `file://${file}` },
      wrapperLength: 0,
    })) as unknown as Record<string, CoverageFile>;
    for (const [path, coverage] of Object.entries(data)) {
      if (!path.includes("/node_modules/")) out[path] = coverage;
    }
  }
  return out;
}

function serverCoverage(): Record<string, CoverageFile> {
  if (filesIn(`${dir}/server-raw`, ".json").length === 0) return {};
  execFileSync(
    resolve("node_modules/.bin/c8"),
    [
      "report",
      "--temp-directory",
      `${dir}/server-raw`,
      "--reports-dir",
      `${dir}/server`,
      "--reporter",
      "json",
      "--exclude",
      "**/node_modules/**",
      "--exclude",
      "apps/web/**",
    ],
    { cwd: root, stdio: "inherit" },
  );
  return JSON.parse(
    readFileSync(`${dir}/server/coverage-final.json`, "utf8"),
  ) as Record<string, CoverageFile>;
}

function line(name: string, files: Record<string, CoverageFile>): string {
  const totals = coverageTotals(Object.values(files));
  const share = (run: number, all: number): string =>
    all === 0 ? "n/a" : `${((run / all) * 100).toFixed(1)} %`;
  return (
    `${name}: ${String(totals.files)} files, ` +
    `statements ${share(totals.statementsRun, totals.statements)}, ` +
    `functions ${share(totals.functionsRun, totals.functions)}`
  );
}

const browser = await browserCoverage();
mkdirSync(`${dir}/client`, { recursive: true });
writeFileSync(`${dir}/client/coverage-final.json`, JSON.stringify(browser));
const server = serverCoverage();

const reported = new Map<string, number>();
for (const file of filesIn(`${dir}/pages`, ".jsonl")) {
  for (const entry of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const { kind } = JSON.parse(entry) as { kind: string };
    reported.set(kind, (reported.get(kind) ?? 0) + 1);
  }
}

console.log(line("Browser", browser));
console.log(line("Server", server));
console.log(
  `Pages reported: ${
    [...reported].map(([kind, n]) => `${kind} ${String(n)}`).join(", ") ||
    "nothing"
  }`,
);
console.log(`Reports: ${dir}`);
