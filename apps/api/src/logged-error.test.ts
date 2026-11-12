import Fastify from "fastify";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  loggedError,
  loggedFields,
  quietError,
  serializeError,
} from "./logged-error.js";

/** An error as a mail server or PostgreSQL raises it: values everywhere. */
function refused(): Error {
  const cause = Object.assign(
    new Error("Key (email)=(ada@example.org) already exists."),
    {
      code: "23505",
      constraint: "users_email_key",
      detail: "Key (email)=(ada@example.org) already exists.",
    },
  );
  return Object.assign(
    new Error("Recipient <ada@example.org> rejected", { cause }),
    {
      code: "EENVELOPE",
      recipient: "ada@example.org",
      response: "550 5.1.1 <ada@example.org>: Recipient address rejected",
    },
  );
}

describe("loggedError", () => {
  it("keeps the kind, the code, the constraint, the frames, and the cause", () => {
    const logged = loggedError(refused());
    expect(logged.type).toBe("Error");
    expect(logged.code).toBe("EENVELOPE");
    expect(logged.stack).toMatch(/^\s+at /);
    expect(logged.cause).toMatchObject({
      type: "Error",
      code: "23505",
      constraint: "users_email_key",
    });
  });

  it("keeps no message and no other property, whatever was thrown", () => {
    expect(JSON.stringify(loggedError(refused()))).not.toContain("ada@");
    // A code is a short token: a value in its place is dropped.
    expect(
      loggedError(Object.assign(new Error("x"), { code: "ada@example.org" }))
        .code,
    ).toBeUndefined();
    expect(loggedError("ada@example.org")).toEqual({ type: "string" });
    expect(loggedError(null)).toEqual({ type: "object" });
    expect(loggedError({ email: "ada@example.org" })).toEqual({
      type: "Object",
    });
  });

  it("stops following causes that loop", () => {
    const loop: Error & { cause?: unknown } = new Error("a");
    loop.cause = loop;
    expect(JSON.stringify(loggedError(loop))).not.toContain("ada@");
  });
});

describe("loggedFields", () => {
  it("keeps texts, numbers and flags, and an error as loggedError keeps it", () => {
    expect(
      loggedFields({
        queue: "worker",
        duration: 5,
        failure: true,
        error: refused(),
      }),
    ).toMatchObject({
      queue: "worker",
      duration: 5,
      failure: true,
      err: { code: "EENVELOPE" },
    });
  });

  it("drops what could hold a value", () => {
    const fields = loggedFields({
      job: { payload: { email: "ada@example.org" } },
      err: refused(),
    });
    expect(JSON.stringify(fields)).not.toContain("ada@");
    expect(fields).not.toHaveProperty("job");
  });
});

describe("quietError", () => {
  it("says the kind and the code, and keeps the frames", () => {
    const quiet = quietError(refused());
    expect(quiet.message).toBe("Error EENVELOPE");
    expect(quiet.stack).toMatch(/\n\s+at /);
  });

  it("quotes nothing of the failure", () => {
    const quiet = quietError(refused());
    expect(`${quiet.message}\n${quiet.stack ?? ""}`).not.toContain("ada@");
  });
});

describe("the server's logger", () => {
  it("writes an error without the value it carried", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            lines.push(chunk.toString());
            done();
          },
        }),
        serializers: { err: serializeError },
      },
    });
    app.log.error({ err: refused() }, "mail failed");
    await app.close();
    const line = lines.join("");
    expect(line).toContain('"code":"EENVELOPE"');
    expect(line).toContain('"message":"Error EENVELOPE"');
    expect(line).toContain("mail failed");
    expect(line).not.toContain("ada@");
  });
});
