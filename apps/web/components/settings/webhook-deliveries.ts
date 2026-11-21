/**
 * What a line of a webhook's delivery log says of its delivery: sent,
 * waiting for its first attempt, tried and to be tried again, or given
 * up. A delivery is written before it is tried, and stays pending while
 * attempts are left: only one that was tried has a retry ahead.
 */
export type DeliveryOutcome = "sent" | "waiting" | "retry" | "failed";

export function deliveryOutcome(delivery: {
  status: string;
  attempts: number;
}): DeliveryOutcome {
  if (delivery.status === "success") return "sent";
  if (delivery.status === "pending") {
    return delivery.attempts > 0 ? "retry" : "waiting";
  }
  return "failed";
}
