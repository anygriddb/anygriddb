/**
 * Every connection the instance opens to the outside goes through the
 * outbound service (ADR 0125, 0135): no module outside `outbound/` imports
 * Node's clients or calls `fetch`, but the few named here, each with why.
 * A library that opens its own (PostgreSQL's driver, the object store's
 * client, the mail transport, a client database's driver) imports none of
 * them from this tree, and is not read here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

/** Node's modules that open a connection. */
const CLIENTS = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "undici",
]);

/** What `node:net` lends that opens nothing: addresses and their lists. */
const NET_NAMES = new Set(["isIP", "isIPv4", "isIPv6", "BlockList"]);

/** The modules that open one, by why. */
const EXCEPTIONS: Record<string, string> = {
  "server.ts":
    "the server's own listening socket, and its redirect of plain HTTP",
  "health-probe.ts":
    "the container's check of its own process, on the loopback",
  "upload-slots.ts":
    "a connection the server accepted, closed when its upload goes quiet",
};

/** Folders that are no part of the running instance. */
const OUTSIDE = [`sources${sep}samples${sep}`];

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.ts$/.test(entry.name) &&
      !/\.test(-helpers)?\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** What a file does that opens a connection, one line each. */
export function opensConnections(file: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      const name = node.moduleSpecifier.text.replace(/^node:/, "");
      if (CLIENTS.has(name)) {
        const bindings = node.importClause?.namedBindings;
        const names =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements
                .filter((element) => !element.isTypeOnly)
                .map((element) => (element.propertyName ?? element.name).text)
            : null;
        const harmless =
          name === "net" &&
          names !== null &&
          node.importClause?.name === undefined &&
          names.every((imported) => NET_NAMES.has(imported));
        if (!harmless && (names === null || names.length > 0)) {
          found.push(`imports ${node.moduleSpecifier.text}`);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named =
        (ts.isIdentifier(callee) && callee.text === "fetch") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fetch" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "globalThis");
      if (named) found.push("calls fetch");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("connections out of the instance", () => {
  it("go through the outbound service, but the ones named with why", () => {
    const opened: string[] = [];
    for (const path of sources(ROOT)) {
      const file = relative(ROOT, path);
      if (file.startsWith(`outbound${sep}`)) continue;
      if (EXCEPTIONS[file] !== undefined) continue;
      if (OUTSIDE.some((folder) => file.startsWith(folder))) continue;
      for (const what of opensConnections(file, readFileSync(path, "utf8"))) {
        opened.push(`${file}: ${what}`);
      }
    }
    expect(opened).toEqual([]);
  });

  it("finds a client imported, fetch called, and leaves an address check alone", () => {
    expect(
      opensConnections(
        "a.ts",
        'import https from "node:https";\nawait fetch("https://example.org");',
      ),
    ).toEqual(["imports node:https", "calls fetch"]);
    expect(
      opensConnections("b.ts", 'import { connect } from "node:tls";'),
    ).toEqual(["imports node:tls"]);
    expect(
      opensConnections(
        "c.ts",
        'import { isIP, type LookupFunction } from "node:net";\nimport type { Agent } from "node:https";\nconst answer = await client.fetch(url);',
      ),
    ).toEqual([]);
  });

  it("names in its list only files that are there", () => {
    const files = new Set(sources(ROOT).map((path) => relative(ROOT, path)));
    expect(Object.keys(EXCEPTIONS).filter((file) => !files.has(file))).toEqual(
      [],
    );
  });
});
