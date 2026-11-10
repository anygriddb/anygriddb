#!/usr/bin/env node
/**
 * Summarize VPS harness JSON results and apply pass/fail thresholds.
 *
 * Usage: node scripts/vps/report.mjs <results-dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function collectJson(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...collectJson(path));
    else if (name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

function errorRate(ok, errors) {
  const total = ok + errors;
  if (total === 0) return 0;
  return errors / total;
}

function evaluate(caseName, doc) {
  const load = doc.load;
  const checks = [];
  if (!load) {
    const ram = caseName.includes("ram-pressure");
    return {
      case: caseName,
      pass: ram,
      checks: [
        {
          name: ram ? "ram_pressure_observed" : "has_load",
          pass: ram,
          detail: ram
            ? `load aborted (exit ${doc.exitCode ?? "?"}); runtime oom=${doc.runtime?.oomKills ?? "n/a"}`
            : "missing load block",
        },
      ],
    };
  }

  const isCredits = caseName.includes("credits");
  const isEntry = caseName.includes("entry");
  const isBalanced = caseName.includes("balanced");
  const isRamPressure = caseName.includes("ram-pressure");
  const isNetLatency = caseName.includes("net-latency");

  const healthReachable = load.health.ok > 0 && load.health.errors === 0;
  checks.push({
    name: "health_reachable",
    pass: isCredits ? load.health.ok > 0 : healthReachable,
    detail: `ok=${load.health.ok} err=${load.health.errors} p95=${load.health.latency.p95?.toFixed?.(1) ?? load.health.latency.p95}`,
  });

  const writeRate = errorRate(load.write.ok, load.write.errors);
  const readRate = errorRate(load.read.ok, load.read.errors);
  const apiP95 = Math.max(
    load.write.latency.p95 ?? 0,
    load.read.latency.p95 ?? 0,
  );
  // Intentional 100ms netem adds RTT to every call; allow a higher ceiling.
  const p95Limit = isNetLatency ? 5000 : 2000;

  if (isBalanced && !isRamPressure) {
    checks.push({
      name: "balanced_error_rate",
      pass: writeRate < 0.01 && readRate < 0.01,
      detail: `write=${(writeRate * 100).toFixed(2)}% read=${(readRate * 100).toFixed(2)}%`,
    });
    checks.push({
      name: "balanced_p95",
      pass: apiP95 < p95Limit,
      detail: `p95=${apiP95.toFixed(1)}ms limit=${p95Limit}`,
    });
    if (doc.runtime?.oomKills) {
      checks.push({
        name: "no_oom_on_balanced",
        pass: doc.runtime.oomKills === 0,
        detail: `oom=${doc.runtime.oomKills}`,
      });
    }
  }

  if (isEntry && !isRamPressure) {
    checks.push({
      name: "entry_error_rate",
      pass: writeRate < 0.01 && readRate < 0.01,
      detail: `write=${(writeRate * 100).toFixed(2)}% read=${(readRate * 100).toFixed(2)}%`,
    });
    checks.push({
      name: "entry_p95",
      pass: apiP95 < p95Limit,
      detail: `p95=${apiP95.toFixed(1)}ms limit=${p95Limit}`,
    });
  }

  if (isCredits) {
    checks.push({
      name: "credits_no_crash_loop",
      pass: (doc.runtime?.restarts ?? 0) < 3 && load.health.ok > 0,
      detail: `restarts=${doc.runtime?.restarts ?? 0} health_ok=${load.health.ok}`,
    });
  }

  if (caseName.includes("net-loss")) {
    checks.push({
      name: "recovers_under_loss",
      pass: load.health.ok > 0 && writeRate < 0.25,
      detail: `health_ok=${load.health.ok} write_err=${(writeRate * 100).toFixed(1)}%`,
    });
  }

  if (isRamPressure) {
    checks.push({
      name: "ram_pressure_observed",
      pass: true,
      detail: `oom=${doc.runtime?.oomKills ?? "n/a"} restarts=${doc.runtime?.restarts ?? "n/a"}`,
    });
  }

  return {
    case: caseName,
    pass: checks.every((c) => c.pass),
    checks,
    summary: {
      writeOk: load.write.ok,
      readOk: load.read.ok,
      writeP95: load.write.latency.p95,
      readP95: load.read.latency.p95,
      healthP95: load.health.latency.p95,
    },
  };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: report.mjs <results-dir>");
    process.exit(1);
  }
  const files = collectJson(dir);
  if (files.length === 0) {
    console.error(`no JSON under ${dir}`);
    process.exit(1);
  }

  const rows = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const caseName =
      doc.case ??
      file
        .slice(dir.length)
        .replace(/^\/+/, "")
        .replace(/\.json$/, "");
    rows.push(evaluate(caseName, doc));
  }

  console.log("case\tpass\twrite_p95\tread_p95\thealth_p95\tdetail");
  for (const row of rows) {
    const failed = row.checks.filter((c) => !c.pass).map((c) => c.name);
    console.log(
      [
        row.case,
        row.pass ? "PASS" : "FAIL",
        row.summary?.writeP95?.toFixed?.(1) ?? "",
        row.summary?.readP95?.toFixed?.(1) ?? "",
        row.summary?.healthP95?.toFixed?.(1) ?? "",
        failed.length ? failed.join(",") : "ok",
      ].join("\t"),
    );
  }

  const report = { generatedAt: new Date().toISOString(), results: rows };
  console.log("");
  console.log(JSON.stringify(report, null, 2));
  if (rows.some((r) => !r.pass)) process.exit(2);
}

main();
