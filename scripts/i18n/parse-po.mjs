#!/usr/bin/env node
import fs from "node:fs";

function unescapePo(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") {
        out += "\n";
        i++;
      } else if (next === "t") {
        out += "\t";
        i++;
      } else if (next === "r") {
        out += "\r";
        i++;
      } else {
        out += next;
        i++;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function readContinuedString(lines, start) {
  const m = lines[start].match(/^"(.*)"\s*$/);
  if (!m) return { text: "", next: start + 1 };
  const parts = [m[1]];
  let i = start + 1;
  while (i < lines.length && /^"/.test(lines[i])) {
    const cm = lines[i].match(/^"(.*)"\s*$/);
    if (cm) parts.push(cm[1]);
    i++;
  }
  return { text: unescapePo(parts.join("")), next: i };
}

export function parsePoFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const entries = [];
  let current = null;
  let refs = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("#:")) {
      const ref = trimmed.slice(2).trim();
      if (ref) refs.push(ref);
      i++;
      continue;
    }

    if (trimmed.startsWith("#") && !trimmed.startsWith("#,")) {
      i++;
      continue;
    }

    if (trimmed.startsWith("msgid ")) {
      if (current) {
        current.references = refs;
        entries.push(current);
      }
      refs = [];
      current = { msgid: "", msgstr: "", references: [] };
      const inline = trimmed.match(/^msgid\s+"(.*)"\s*$/);
      if (inline) {
        current.msgid = unescapePo(inline[1]);
        i++;
        if (i < lines.length && /^"/.test(lines[i])) {
          const cont = readContinuedString(lines, i);
          current.msgid += cont.text;
          i = cont.next;
        }
      } else if (trimmed === 'msgid ""') {
        i++;
        const cont = readContinuedString(lines, i);
        current.msgid = cont.text;
        i = cont.next;
      } else {
        i++;
      }
      continue;
    }

    if (trimmed.startsWith("msgid_plural ")) {
      if (!current) {
        i++;
        continue;
      }
      const inline = trimmed.match(/^msgid_plural\s+"(.*)"\s*$/);
      if (inline) {
        current.msgid_plural = unescapePo(inline[1]);
        i++;
        if (i < lines.length && /^"/.test(lines[i])) {
          const cont = readContinuedString(lines, i);
          current.msgid_plural += cont.text;
          i = cont.next;
        }
      } else {
        i++;
      }
      continue;
    }

    if (trimmed.startsWith("msgstr[")) {
      if (!current) {
        i++;
        continue;
      }
      const idxMatch = trimmed.match(/^msgstr\[(\d+)\]\s+"(.*)"\s*$/);
      if (idxMatch) {
        const idx = Number(idxMatch[1]);
        if (!current.msgstr_plural) current.msgstr_plural = [];
        current.msgstr_plural[idx] = unescapePo(idxMatch[2]);
        i++;
        if (i < lines.length && /^"/.test(lines[i])) {
          const cont = readContinuedString(lines, i);
          current.msgstr_plural[idx] =
            (current.msgstr_plural[idx] ?? "") + cont.text;
          i = cont.next;
        }
      } else {
        i++;
      }
      continue;
    }

    if (trimmed.startsWith("msgstr ")) {
      if (!current) {
        i++;
        continue;
      }
      const inline = trimmed.match(/^msgstr\s+"(.*)"\s*$/);
      if (inline) {
        current.msgstr = unescapePo(inline[1]);
        i++;
        if (i < lines.length && /^"/.test(lines[i])) {
          const cont = readContinuedString(lines, i);
          current.msgstr += cont.text;
          i = cont.next;
        }
      } else if (trimmed === 'msgstr ""') {
        i++;
        const cont = readContinuedString(lines, i);
        current.msgstr = cont.text;
        i = cont.next;
      } else {
        i++;
      }
      continue;
    }

    i++;
  }

  if (current) {
    current.references = refs;
    entries.push(current);
  }

  return entries;
}
