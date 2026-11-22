import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { cutIdleUpload, uploadSlots } from "./upload-slots.js";

describe("uploadSlots", () => {
  it("gives slots up to its ceiling, then refuses", () => {
    const slots = uploadSlots(2, 2);
    const first = slots.take("a");
    const second = slots.take("b");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(slots.take("c")).toBeUndefined();
    first?.();
    expect(slots.take("c")).toBeDefined();
  });

  it("counts a slot given back twice once", () => {
    const slots = uploadSlots(1, 1);
    const done = slots.take("a");
    done?.();
    done?.();
    expect(slots.busy).toBe(0);
    expect(slots.take("a")).toBeDefined();
    expect(slots.take("b")).toBeUndefined();
  });

  it("lets someone send one file after another on a small ceiling", () => {
    const slots = uploadSlots(3);
    const first = slots.take("sender");
    const next = slots.take("sender");
    expect(first).toBeDefined();
    expect(next).toBeDefined();
    expect(slots.take("sender")).toBeUndefined();
  });

  it("keeps one holder from taking every slot", () => {
    const slots = uploadSlots(8);
    expect(slots.take("greedy")).toBeDefined();
    const second = slots.take("greedy");
    expect(second).toBeDefined();
    expect(slots.take("greedy")).toBeUndefined();
    expect(slots.take("someone else")).toBeDefined();
    second?.();
    expect(slots.take("greedy")).toBeDefined();
  });
});

describe("cutIdleUpload", () => {
  const socketDouble = () => {
    const socket = new Socket();
    return Object.assign(socket, {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    });
  };
  const on = (socket: Socket) => ({ socket });

  it("closes a connection that stops sending", () => {
    const socket = socketDouble();
    cutIdleUpload(on(socket), { writableEnded: false }, 1_000);
    expect(socket.setTimeout).toHaveBeenCalledWith(1_000);
    socket.emit("timeout");
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("leaves it alone once the body has arrived", () => {
    const socket = socketDouble();
    const received = cutIdleUpload(on(socket), { writableEnded: false }, 1_000);
    received();
    received();
    socket.emit("timeout");
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.setTimeout).toHaveBeenLastCalledWith(0);
    expect(socket.setTimeout).toHaveBeenCalledTimes(2);
  });

  it("has nothing to watch on a request made in-process", () => {
    const received = cutIdleUpload(
      { socket: {} as Socket },
      { writableEnded: false },
    );
    expect(received).not.toThrow();
  });

  it("does not take the timer back from an answered request", () => {
    const socket = socketDouble();
    const received = cutIdleUpload(on(socket), { writableEnded: true }, 1_000);
    received();
    expect(socket.setTimeout).toHaveBeenCalledTimes(1);
  });
});
