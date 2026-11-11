import { describe, expect, it } from "vitest";
import { readinessProbe } from "./readiness.js";

describe("readiness", () => {
  it("is ready when the database answers, whatever realtime does", async () => {
    const probe = readinessProbe({
      ping: () => Promise.resolve(1),
      listening: () => false,
    });
    expect(await probe()).toEqual({
      ok: true,
      database: true,
      realtime: false,
    });
  });

  it("is not ready when the database fails or answers too late", async () => {
    const failing = readinessProbe({
      ping: () => Promise.reject(new Error("connection refused")),
      listening: () => true,
    });
    expect(await failing()).toEqual({
      ok: false,
      database: false,
      realtime: true,
    });
    // Every connection is taken: the ping never gets one.
    const waiting = readinessProbe({
      ping: () => new Promise(() => undefined),
      listening: () => true,
      withinMs: 10,
    });
    expect((await waiting()).ok).toBe(false);
  });

  it("asks the database once a second at most", async () => {
    let pings = 0;
    let clock = 0;
    const probe = readinessProbe({
      ping: () => {
        pings += 1;
        return Promise.resolve(1);
      },
      listening: () => true,
      now: () => clock,
    });
    await Promise.all([probe(), probe(), probe()]);
    expect(pings).toBe(1);
    clock = 1_500;
    await probe();
    expect(pings).toBe(2);
  });
});
