import type { Bus } from "./bus.js";

/** A bus that records what is published, for tests. */
export function recordingBus() {
  const published: Array<{ channel: string; message: unknown }> = [];
  const bus: Bus = {
    publish: (channel, message) => {
      published.push({ channel, message: JSON.parse(message) as unknown });
      return Promise.resolve();
    },
    onMessage: () => undefined,
    onReconnect: () => undefined,
    listening: () => true,
    close: () => Promise.resolve(),
  };
  return { bus, published };
}
