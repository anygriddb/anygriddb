import { useState } from "react";

/**
 * Lets one send through at a time. It holds its state outside React: two
 * clicks can land before the page has drawn the button as busy.
 */
export class SubmitGuard {
  private running = false;

  constructor(private readonly onBusy?: (busy: boolean) => void) {}

  /** Runs `send`, unless one is still under way. */
  run(send: () => Promise<unknown>): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.onBusy?.(true);
    return send().then(
      () => {
        this.release();
      },
      (cause: unknown) => {
        this.release();
        throw cause;
      },
    );
  }

  private release(): void {
    this.running = false;
    this.onBusy?.(false);
  }
}

/** A guard for one form or button, and whether it is sending. */
export function useSubmitGuard(): {
  busy: boolean;
  guard: (send: () => Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [guard] = useState(() => new SubmitGuard(setBusy));
  return { busy, guard: (send) => guard.run(send) };
}
