import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerClientErrors } from "./client-errors.js";
import { registry } from "./observability.js";

const ORIGIN = "https://grid.example.org";

async function server() {
  const lines: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: {
      level: "warn",
      stream: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    },
  });
  registerClientErrors(app, { publicUrl: ORIGIN });
  await app.ready();
  const report = (payload: unknown, origin: string | null = ORIGIN) =>
    app.inject({
      method: "POST",
      url: "/api/client-errors",
      headers: {
        "content-type": "application/json",
        ...(origin === null ? {} : { origin }),
      },
      payload: payload as Record<string, unknown>,
    });
  return { lines, report };
}

async function counted(kind: string): Promise<number> {
  const text = await registry.getSingleMetricAsString(
    "anygriddb_client_errors_total",
  );
  const found = new RegExp(
    `anygriddb_client_errors_total\\{kind="${kind}"\\} (\\d+)`,
  ).exec(text);
  return Number(found?.[1] ?? 0);
}

describe("failures pages report", () => {
  it("logs and counts a report, with a secret address masked", async () => {
    const { lines, report } = await server();
    const before = await counted("render");
    const response = await report({
      kind: "render",
      message: "Cannot read properties of undefined\r\nforged line",
      stack: `TypeError: boom\n    at Grid (grid-view.tsx:12:3)\n\n    at ${"x".repeat(900)}`,
      path: "/s/shr_secret-token",
    });
    expect(response.statusCode).toBe(204);
    expect(await counted("render")).toBe(before + 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("page failed in a browser");
    const client = lines[0]?.client as {
      message: string;
      path: string;
      stack: string[];
    };
    expect(client.message).toBe(
      "Cannot read properties of undefinedforged line",
    );
    expect(client.path).toBe("/s/…");
    expect(client.stack).toHaveLength(3);
    expect(client.stack[1]).toBe("at Grid (grid-view.tsx:12:3)");
    expect(client.stack[2]).toHaveLength(300);
    expect(JSON.stringify(lines[0])).not.toContain("shr_secret-token");
  });

  it("refuses another site's page, an unknown kind, and too many words", async () => {
    const { lines, report } = await server();
    const before = await counted("error");
    const valid = { kind: "error", message: "boom", path: "/login" };
    expect((await report(valid, "https://elsewhere.example")).statusCode).toBe(
      403,
    );
    expect((await report({ ...valid, kind: "crash" })).statusCode).toBe(400);
    expect(
      (await report({ ...valid, message: "m".repeat(501) })).statusCode,
    ).toBe(400);
    expect((await report({ kind: "error" })).statusCode).toBe(400);
    expect(
      (await report({ ...valid, stack: "s".repeat(20_000) })).statusCode,
    ).toBe(413);
    expect(lines).toEqual([]);
    expect(await counted("error")).toBe(before);
    // A request without an origin (not a browser's cross-site call) passes.
    expect((await report(valid, null)).statusCode).toBe(204);
  });
});
