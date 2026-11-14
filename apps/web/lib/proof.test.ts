import type { Operation, OperationResultEnvelope } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { afterEach, describe, expect, it } from "vitest";
import { proofLink, setProofAsker } from "./proof";

const refusal = { data: { reason: { code: "step_up_required" } } };
const answer = {
  result: { type: "data", data: "done" },
} as OperationResultEnvelope<unknown, never>;

/** Sends one call through the link; `server` answers each time it is sent. */
function send(
  type: "query" | "mutation",
  server: (attempt: number) => "ok" | object,
): Promise<{ outcome: "ok" | object; sent: number }> {
  let sent = 0;
  const link = proofLink<AnyRouter>()({});
  const op = { type, path: "admin.setAdmin", id: 1 } as Operation;
  return new Promise((resolve) => {
    link({
      op,
      next: () =>
        observable((observer) => {
          sent += 1;
          const reply = server(sent);
          if (reply === "ok") {
            observer.next(answer as never);
            observer.complete();
          } else {
            observer.error(reply as never);
          }
        }),
    }).subscribe({
      error: (error) => resolve({ outcome: error as object, sent }),
      complete: () => resolve({ outcome: "ok", sent }),
    });
  });
}

describe("proofLink", () => {
  afterEach(() => setProofAsker(null));

  it("sends a refused change again once the proof is given", async () => {
    let asked = 0;
    setProofAsker(() => {
      asked += 1;
      return Promise.resolve(true);
    });
    expect(
      await send("mutation", (attempt) => (attempt === 1 ? refusal : "ok")),
    ).toEqual({ outcome: "ok", sent: 2 });
    expect(asked).toBe(1);
  });

  it("asks once only: a change refused again is refused", async () => {
    setProofAsker(() => Promise.resolve(true));
    expect(await send("mutation", () => refusal)).toEqual({
      outcome: refusal,
      sent: 2,
    });
  });

  it("hands the refusal on when the person gives up, or nobody asks", async () => {
    expect(await send("mutation", () => refusal)).toEqual({
      outcome: refusal,
      sent: 1,
    });
    setProofAsker(() => Promise.resolve(false));
    expect(await send("mutation", () => refusal)).toEqual({
      outcome: refusal,
      sent: 1,
    });
  });

  it("leaves reads and other refusals alone", async () => {
    let asked = 0;
    setProofAsker(() => {
      asked += 1;
      return Promise.resolve(true);
    });
    const denied = { data: { reason: { code: "access_denied" } } };
    expect(await send("query", () => refusal)).toEqual({
      outcome: refusal,
      sent: 1,
    });
    expect(await send("mutation", () => denied)).toEqual({
      outcome: denied,
      sent: 1,
    });
    expect(asked).toBe(0);
  });

  it("asks one question for changes refused together", async () => {
    let asked = 0;
    let give: (proved: boolean) => void = () => undefined;
    setProofAsker(() => {
      asked += 1;
      return new Promise<boolean>((resolve) => {
        give = resolve;
      });
    });
    const both = Promise.all([
      send("mutation", (attempt) => (attempt === 1 ? refusal : "ok")),
      send("mutation", (attempt) => (attempt === 1 ? refusal : "ok")),
    ]);
    await Promise.resolve();
    give(true);
    expect(await both).toEqual([
      { outcome: "ok", sent: 2 },
      { outcome: "ok", sent: 2 },
    ]);
    expect(asked).toBe(1);
  });
});
