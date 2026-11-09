#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoFile, entriesToMap } from "./parse-po.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const webRoot = path.join(root, "apps/web");
const frPo = path.join(webRoot, "locales/fr/messages.po");
const enPo = path.join(webRoot, "locales/en/messages.po");
const mapPath = path.join(root, "scripts/i18n/.flip-map.json");

const frEntries = parsePoFile(frPo);
const enEntries = parsePoFile(enPo);
const frToEn = entriesToMap(enEntries);
const enToFr = new Map();
for (const [fr, en] of frToEn) {
  if (en) enToFr.set(en, fr);
}

fs.writeFileSync(
  mapPath,
  JSON.stringify(
    { frToEn: Object.fromEntries(frToEn), enToFr: Object.fromEntries(enToFr) },
    null,
    2,
  ),
);

const stats = { filesChanged: 0, macrosRewritten: 0, untranslated: 0 };

function scanBalanced(src, start, openCh, closeCh) {
  let depth = 0;
  let i = start;
  let quote = null;
  let escape = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function findCommaAtDepth0(src, start) {
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return src.length;
}

function parseStringLiteral(src, start) {
  const q = src[start];
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "r") value += "\r";
      else value += next;
      i += 2;
      continue;
    }
    if (ch === q) return { value, end: i };
    value += ch;
    i++;
  }
  return null;
}

function parseTemplateLiteral(src, start) {
  let i = start + 1;
  const cooked = [];
  const expressions = [];
  let current = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "`") current += "`";
      else if (next === "$") current += "$";
      else if (next === "\\") current += "\\";
      else current += next;
      i += 2;
      continue;
    }
    if (ch === "$" && src[i + 1] === "{") {
      cooked.push(current);
      current = "";
      const exprStart = i + 2;
      const exprEnd = scanBalanced(src, i + 1, "{", "}");
      if (exprEnd < 0) return null;
      expressions.push(src.slice(exprStart, exprEnd));
      i = exprEnd + 1;
      continue;
    }
    if (ch === "`") {
      cooked.push(current);
      return { cooked, expressions, end: i };
    }
    current += ch;
    i++;
  }
  return null;
}

function parseDoubleBrace(expr) {
  const s = expr.trim();
  if (!s.startsWith("{{") || !s.endsWith("}}")) return null;
  const inner = s.slice(2, -2).trim();
  const colon = inner.indexOf(":");
  if (colon < 0) return null;
  const name = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (!/^\w+$/.test(name)) return null;
  return { name, rebuild: `${name}: ${value}` };
}

function parseNamedObjectExpr(expr) {
  const s = expr.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const inner = s.slice(1, -1).trim();
  const colon = inner.indexOf(":");
  if (colon < 0) {
    const solo = inner.match(/^(\w+)$/);
    if (solo) {
      const name = solo[1];
      return { name, raw: s, kind: "named", rebuild: `${name}: ${name}` };
    }
    return null;
  }
  const name = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (!/^\w+$/.test(name)) return null;
  return { name, raw: s, kind: "named", rebuild: `${name}: ${value}` };
}

function exprToPlaceholder(ex) {
  const named = parseNamedObjectExpr(ex);
  if (named) return named;
  const db = parseDoubleBrace(ex);
  if (db)
    return {
      name: db.name,
      raw: ex.trim(),
      kind: "named",
      rebuild: db.rebuild,
    };
  const ph = parsePhCall(ex);
  if (ph) return { name: ph.name, raw: ex.trim(), kind: "ph" };
  const sm = ex.trim().match(/^([\w$]+)$/);
  if (sm) return { name: sm[1], raw: ex.trim(), kind: "simple" };
  return null;
}

function exprToTemplateSlot(slot) {
  if (slot.kind === "named") return "${{" + slot.rebuild + "}}";
  return "${" + slot.raw + "}";
}

function parsePhCall(expr) {
  const s = expr.trim();
  const m = s.match(/^ph\(\s*\{/);
  if (!m) return null;
  const end = scanBalanced(s, s.indexOf("{"), "{", "}");
  if (end < 0) return null;
  const inner = s.slice(s.indexOf("{") + 1, end);
  const colon = inner.indexOf(":");
  if (colon < 0) return null;
  const name = inner.slice(0, colon).trim();
  if (!/^\w+$/.test(name)) return null;
  return { name, rebuild: null, full: s };
}

function formToPattern(formSrc) {
  const trimmed = formSrc.trim();
  const placeholders = new Map();
  if (
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed[0] === trimmed.at(-1)
  ) {
    const lit = parseStringLiteral(trimmed, 0);
    if (lit) return { pattern: lit.value, placeholders };
  }
  if (trimmed.startsWith("`")) {
    const tmpl = parseTemplateLiteral(trimmed, 0);
    if (!tmpl) return null;
    let pattern = "";
    for (let k = 0; k < tmpl.cooked.length; k++) {
      pattern += tmpl.cooked[k];
      if (k < tmpl.expressions.length) {
        const ex = tmpl.expressions[k];
        const slot = exprToPlaceholder(ex);
        if (!slot) return null;
        placeholders.set(slot.name, slot);
        pattern += `{${slot.name}}`;
        continue;
      }
    }
    return { pattern, placeholders };
  }
  return { pattern: trimmed, placeholders };
}

function rebuildFormFromEnglish(text, placeholders) {
  const re = /\{([a-zA-Z_][\w]*)\}/g;
  let last = 0;
  let m;
  const parts = [];
  let hasSub = false;
  while ((m = re.exec(text))) {
    parts.push({ type: "text", value: text.slice(last, m.index) });
    const name = m[1];
    const orig = placeholders.get(name);
    if (!orig) return null;
    parts.push({ type: "expr", slot: orig });
    hasSub = true;
    last = m.index + m[0].length;
  }
  parts.push({ type: "text", value: text.slice(last) });
  if (!hasSub && !text.includes("#") && !text.includes("\n")) {
    return JSON.stringify(text);
  }
  let out = "`";
  for (const p of parts) {
    if (p.type === "text") {
      out += p.value
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${");
    } else {
      out += exprToTemplateSlot(p.slot);
    }
  }
  out += "`";
  return out;
}

function templateToMsgid(tmpl) {
  let pattern = "";
  const placeholders = new Map();
  for (let k = 0; k < tmpl.cooked.length; k++) {
    pattern += tmpl.cooked[k];
    if (k < tmpl.expressions.length) {
      const slot = exprToPlaceholder(tmpl.expressions[k]);
      if (!slot) return null;
      placeholders.set(slot.name, slot);
      pattern += `{${slot.name}}`;
    }
  }
  return { pattern, placeholders };
}

function escapeTemplateStatic(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function englishToTaggedTemplate(tag, english, placeholders) {
  const re = /\{([a-zA-Z_][\w]*)\}/g;
  let last = 0;
  let out = `${tag}\``;
  let m;
  while ((m = re.exec(english))) {
    out += escapeTemplateStatic(english.slice(last, m.index));
    const name = m[1];
    const slot = placeholders.get(name);
    if (!slot) return null;
    out += exprToTemplateSlot(slot);
    last = m.index + m[0].length;
  }
  out += escapeTemplateStatic(english.slice(last));
  out += "`";
  return out;
}

function buildIcu(varName, forms) {
  const bits = [];
  if (forms["0"] !== undefined) bits.push(`=0 {${forms["0"]}}`);
  if (forms.one !== undefined) bits.push(`one {${forms.one}}`);
  if (forms.other !== undefined) bits.push(`other {${forms.other}}`);
  return `{${varName}, plural, ${bits.join(" ")}}`;
}

function scanBracesOnly(src, start) {
  if (src[start] !== "{") return -1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseIcuPlural(icu) {
  const m = icu.match(/^\{([^,]+),\s*plural,\s*/);
  if (!m) return null;
  let i = m[0].length;
  const branches = {};
  while (i < icu.length) {
    i = skipWs(icu, i);
    if (icu[i] === "}") break;
    let key;
    if (icu[i] === "=") {
      key = "0";
      i += 2;
    } else {
      const km = icu.slice(i).match(/^(one|other|few|many|zero)\b/);
      if (!km) break;
      key = km[1] === "zero" ? "0" : km[1];
      i += km[0].length;
    }
    i = skipWs(icu, i);
    if (icu[i] !== "{") break;
    const end = scanBracesOnly(icu, i);
    if (end < 0) break;
    branches[key] = icu.slice(i + 1, end);
    i = end + 1;
  }
  return branches;
}

function parsePluralForms(objSrc) {
  const forms = {};
  const phRe = /\b(0|one|other)\s*:\s*/g;
  let m;
  while ((m = phRe.exec(objSrc))) {
    const key = m[1];
    let i = skipWs(objSrc, m.index + m[0].length);
    let raw;
    if (objSrc[i] === '"' || objSrc[i] === "'") {
      const lit = parseStringLiteral(objSrc, i);
      if (!lit) continue;
      raw = objSrc.slice(i, lit.end + 1);
    } else if (objSrc[i] === "`") {
      const tmpl = parseTemplateLiteral(objSrc, i);
      if (!tmpl) continue;
      raw = objSrc.slice(i, tmpl.end + 1);
    } else {
      const comma = findCommaAtDepth0(objSrc, i);
      raw = objSrc.slice(i, comma).trim();
    }
    forms[key] = raw;
  }
  return forms;
}

function translatePluralCall(src, startIdx) {
  const open = src.indexOf("(", startIdx);
  if (open < 0) return null;
  let i = skipWs(src, open + 1);
  let varName = "0";
  let firstArg;
  if (src[i] === "{") {
    const end = scanBalanced(src, i, "{", "}");
    if (end < 0) return null;
    firstArg = src.slice(i, end + 1);
    const km = firstArg.match(/^\{\s*(\w+)\s*:/);
    if (km) varName = km[1];
    i = end + 1;
  } else {
    const comma = findCommaAtDepth0(src, i);
    firstArg = src.slice(i, comma).trim();
    i = comma;
  }
  i = skipWs(src, i);
  if (src[i] !== ",") return null;
  i = skipWs(src, i + 1);
  if (src[i] !== "{") return null;
  const objEnd = scanBalanced(src, i, "{", "}");
  if (objEnd < 0) return null;
  const objSrc = src.slice(i, objEnd + 1);
  const formSrcs = parsePluralForms(objSrc);
  const patterns = {};
  const allPh = new Map();
  for (const key of Object.keys(formSrcs)) {
    const fp = formToPattern(formSrcs[key]);
    if (!fp) return null;
    patterns[key] = fp.pattern;
    for (const [n, v] of fp.placeholders) allPh.set(key + ":" + n, v);
  }
  const frenchIcu = buildIcu(varName, patterns);
  const englishIcu = frToEn.get(frenchIcu);
  if (!englishIcu) {
    stats.untranslated++;
    return null;
  }
  const enBranches = parseIcuPlural(englishIcu);
  if (!enBranches) {
    stats.untranslated++;
    return null;
  }
  const newFormSrcs = {};
  for (const key of Object.keys(formSrcs)) {
    const enText = enBranches[key];
    if (enText === undefined) {
      stats.untranslated++;
      return null;
    }
    const ph = new Map();
    for (const [nk, v] of allPh) {
      if (nk.startsWith(key + ":")) ph.set(nk.slice(key.length + 1), v);
    }
    const rebuilt = rebuildFormFromEnglish(enText, ph);
    if (!rebuilt) {
      stats.untranslated++;
      return null;
    }
    newFormSrcs[key] = rebuilt;
  }
  const inner = Object.entries(newFormSrcs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  let close = objEnd + 1;
  close = skipWs(src, close);
  if (src[close] === ",") close = skipWs(src, close + 1);
  if (src[close] === ")") close++;
  const replacement = `plural(${firstArg}, { ${inner} })`;
  return { start: startIdx, end: close, replacement };
}

function translateTagged(src, startIdx, tag) {
  const backtick = src.indexOf("`", startIdx);
  if (backtick < 0) return null;
  const tmpl = parseTemplateLiteral(src, backtick);
  if (!tmpl) return null;
  const conv = templateToMsgid(tmpl);
  if (!conv) {
    if (
      process.env.TRACE &&
      src.includes("lignes supprimées") &&
      startIdx < src.indexOf("lignes supprimées") &&
      src.indexOf("lignes supprimées") < startIdx + 200
    )
      console.error("NO_CONV", startIdx);
    return null;
  }
  const english = frToEn.get(conv.pattern);
  if (!english) {
    stats.untranslated++;
    return null;
  }
  const rebuilt = englishToTaggedTemplate(tag, english, conv.placeholders);
  if (!rebuilt) {
    stats.untranslated++;
    return null;
  }
  return { start: startIdx, end: tmpl.end + 1, replacement: rebuilt };
}

function keepInnerOnly(replacements) {
  return replacements.filter((a) => {
    const enclosesOther = replacements.some(
      (b) =>
        b !== a &&
        a.start <= b.start &&
        b.end <= a.end &&
        (a.start < b.start || b.end < a.end),
    );
    return !enclosesOther;
  });
}

function flipContent(content) {
  const replacements = [];
  const pluralRe = /\bplural\s*\(/g;
  let pm;
  while ((pm = pluralRe.exec(content))) {
    const tr = translatePluralCall(content, pm.index);
    if (tr) replacements.push(tr);
  }
  const tagRe = /\b(t|msg)\s*`/g;
  let tm;
  while ((tm = tagRe.exec(content))) {
    const before = tm.index > 0 ? content[tm.index - 1] : "";
    if (/[\w$]/.test(before)) continue;
    const tr = translateTagged(content, tm.index, tm[1]);
    if (tr) replacements.push(tr);
  }
  const inner = keepInnerOnly(replacements);
  inner.sort((a, b) => b.start - a.start);
  let out = content;
  let changed = 0;
  for (const r of inner) {
    if (out.slice(r.start, r.end) === r.replacement) continue;
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
    changed++;
    stats.macrosRewritten++;
  }
  return { out, changed };
}

function walkDir(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p, files);
    else if (/\.tsx?$/.test(ent.name) && !ent.name.endsWith(".test.ts"))
      files.push(p);
  }
  return files;
}

const dirs = ["app", "components", "lib"].map((d) => path.join(webRoot, d));
const files = dirs.flatMap((d) => (fs.existsSync(d) ? walkDir(d) : []));

for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  let content = original;
  let prev = "";
  let passes = 0;
  while (content !== prev && passes < 30) {
    prev = content;
    const { out } = flipContent(content);
    content = out;
    passes++;
  }
  if (content !== original) {
    fs.writeFileSync(file, content);
    stats.filesChanged++;
  }
}

console.log("flip-source complete");
console.log(`  files changed:       ${stats.filesChanged}`);
console.log(`  macros rewritten:    ${stats.macrosRewritten}`);
console.log(`  untranslated lookups: ${stats.untranslated}`);
console.log(`  map saved:           ${mapPath}`);
