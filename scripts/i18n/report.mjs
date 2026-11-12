#!/usr/bin/env node
/**
 * Catalog health for English source + French translations (ADR 0041).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoFile } from "./parse-po.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const frPo = path.join(root, "apps/web/locales/fr/messages.po");
const enPo = path.join(root, "apps/web/locales/en/messages.po");

function extractPlaceholders(text) {
  const names = [];
  const re = /\{([a-zA-Z_][\w]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.sort();
}

const frEntries = parsePoFile(frPo);
const enEntries = parsePoFile(enPo);
const enIds = new Set(enEntries.filter((e) => e.msgid).map((e) => e.msgid));
const frIds = new Set(frEntries.filter((e) => e.msgid).map((e) => e.msgid));

let total = 0;
let emptyFr = 0;
let emptyEn = 0;
let identicalFr = 0;
let placeholderMismatch = 0;
const mismatchSamples = [];
let typography = 0;
const typographySamples = [];

/**
 * French typography: a typographic apostrophe, and a non-breaking space
 * before a colon, a semicolon, a question mark or an exclamation mark that
 * ends a clause. A mark that opens a piece of code (`?records=`, `!=`) is
 * not one.
 */
const STRAIGHT_APOSTROPHE = /'/;
const BREAKING_SPACE = / [:;?!](?=\s|$|[»).}])/;

for (const fr of frEntries) {
  if (!fr.msgid) continue;
  total++;
  const msgstr = fr.msgstr ?? "";
  if (msgstr === "") emptyFr++;
  if (msgstr === fr.msgid) identicalFr++;
  const idPh = extractPlaceholders(fr.msgid);
  const strPh = extractPlaceholders(msgstr);
  if (STRAIGHT_APOSTROPHE.test(msgstr) || BREAKING_SPACE.test(msgstr)) {
    typography++;
    if (typographySamples.length < 10) typographySamples.push(msgstr);
  }
  if (idPh.join(",") !== strPh.join(",")) {
    placeholderMismatch++;
    if (mismatchSamples.length < 10) {
      mismatchSamples.push({ msgid: fr.msgid.slice(0, 80), idPh, strPh });
    }
  }
}

for (const en of enEntries) {
  if (!en.msgid) continue;
  if ((en.msgstr ?? "") === "") emptyEn++;
}

const onlyEn = [...enIds].filter((id) => !frIds.has(id)).length;
const onlyFr = [...frIds].filter((id) => !enIds.has(id)).length;

console.log("PO translation report (English source)");
console.log(`  total FR msgids:           ${total}`);
console.log(`  empty FR msgstr:           ${emptyFr}`);
console.log(`  empty EN msgstr:           ${emptyEn}`);
console.log(
  `  FR msgstr === msgid:       ${identicalFr} (ok for shared terms)`,
);
console.log(`  placeholder mismatches:    ${placeholderMismatch}`);
console.log(`  French typography:         ${typography}`);
console.log(`  only in en:                ${onlyEn}`);
console.log(`  only in fr:                ${onlyFr}`);
if (mismatchSamples.length) {
  console.log("  sample mismatches:");
  for (const s of mismatchSamples) {
    console.log(`    ${JSON.stringify(s.msgid)} id=${s.idPh} str=${s.strPh}`);
  }
}

if (typographySamples.length) {
  console.log(
    "  French: use ’ for the apostrophe and a non-breaking space before : ; ? !",
  );
  for (const sample of typographySamples) {
    console.log(`    ${JSON.stringify(sample.slice(0, 80))}`);
  }
}

if (
  typography > 0 ||
  emptyFr > 0 ||
  emptyEn > 0 ||
  onlyEn > 0 ||
  onlyFr > 0 ||
  placeholderMismatch > 0
) {
  console.error("\nFAIL: catalogs incomplete or mismatched");
  process.exit(1);
}
