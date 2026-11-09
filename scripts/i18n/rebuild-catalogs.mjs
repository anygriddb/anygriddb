#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePoFile, escapePo, unescapePo } from "./parse-po.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mapPath = path.join(root, "scripts/i18n/.flip-map.json");
const enPo = path.join(root, "apps/web/locales/en/messages.po");
const frPo = path.join(root, "apps/web/locales/fr/messages.po");

if (!fs.existsSync(mapPath)) {
  console.error("Missing .flip-map.json — run flip-source.mjs first");
  process.exit(1);
}

const { enToFr } = JSON.parse(fs.readFileSync(mapPath, "utf8"));

function formatEntryBlock(lines, msgid, msgstr) {
  const idLines = msgid.split("\n");
  const strLines = msgstr.split("\n");
  if (idLines.length === 1) {
    lines.push(`msgid "${escapePo(idLines[0])}"`);
  } else {
    lines.push('msgid ""');
    for (const l of idLines) lines.push(`"${escapePo(l)}"`);
  }
  if (strLines.length === 1) {
    lines.push(`msgstr "${escapePo(strLines[0])}"`);
  } else {
    lines.push('msgstr ""');
    for (const l of strLines) lines.push(`"${escapePo(l)}"`);
  }
}

function rebuildPo(filePath, locale) {
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = parsePoFile(filePath);
  let missing = 0;
  const headerEnd = raw.indexOf("\n\n", raw.indexOf('msgstr ""'));
  const header = raw.slice(
    0,
    headerEnd + (raw[headerEnd + 1] === "\n" ? 2 : 1),
  );

  const out = [header.trimEnd(), ""];
  for (const ent of entries) {
    if (!ent.msgid) continue;
    for (const ref of ent.references) out.push(`#: ${ref}`);
    let msgstr;
    if (locale === "en") {
      msgstr = ent.msgid;
    } else {
      msgstr = enToFr[ent.msgid] ?? "";
      if (!msgstr) missing++;
    }
    const block = [];
    formatEntryBlock(block, ent.msgid, msgstr);
    out.push(...block, "");
  }

  fs.writeFileSync(filePath, out.join("\n"));
  return missing;
}

const enMissing = rebuildPo(enPo, "en");
const frMissing = rebuildPo(frPo, "fr");

console.log("rebuild-catalogs complete");
console.log(`  fr entries missing French msgstr: ${frMissing}`);
console.log(`  en.po identity catalog written`);
