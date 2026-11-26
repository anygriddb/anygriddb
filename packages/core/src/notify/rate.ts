import { ceilingOf } from "../limits";
/** How long the same subject is not sent again to the same channel. */
export const NOTIFY_DEDUPE_MS = ceilingOf("channel.same_subject_ms");

/** How many deliveries one channel may start in a window. */
export const NOTIFY_RATE_MAX = ceilingOf("channel.deliveries_per_window");

export const NOTIFY_RATE_WINDOW_MS = ceilingOf("channel.rate_window_ms");

/** Exhausted deliveries in a row before a channel is paused. */
export const NOTIFY_FAILURE_LIMIT = ceilingOf("channel.failures_before_pause");

/** How many channels one instance may have. */
export const MAX_INTEGRATIONS = ceilingOf("channel.per_instance");

export type RateState = {
  now: number;
  windowStartedAt: number | null;
  sent: number;
  /** When this channel last accepted the same event and subject. */
  lastSameAt: number | null;
};

export type RateDecision = {
  action: "send" | "suppress";
  /** The window the counters belong to after this decision. */
  windowStartedAt: number;
  sent: number;
  suppressed: number;
  /** True when the previous window was discarded. */
  reset: boolean;
};

/**
 * Whether this event may start a delivery. A repeat of the same subject
 * inside five minutes, or a twenty-first delivery inside the hour, is
 * counted and not sent.
 */
export function rateDecision(
  state: RateState,
  suppressed: number,
): RateDecision {
  const reset =
    state.windowStartedAt === null ||
    state.now - state.windowStartedAt >= NOTIFY_RATE_WINDOW_MS;
  const windowStartedAt =
    state.windowStartedAt === null || reset ? state.now : state.windowStartedAt;
  const sent = reset ? 0 : state.sent;
  const kept = reset ? 0 : suppressed;
  const recent =
    state.lastSameAt !== null &&
    state.now - state.lastSameAt < NOTIFY_DEDUPE_MS;
  if (recent || sent >= NOTIFY_RATE_MAX) {
    return {
      action: "suppress",
      windowStartedAt,
      sent,
      suppressed: kept + 1,
      reset,
    };
  }
  return {
    action: "send",
    windowStartedAt,
    sent: sent + 1,
    suppressed: kept,
    reset,
  };
}
