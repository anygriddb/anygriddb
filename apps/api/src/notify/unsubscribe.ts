/**
 * Signed unsubscribe links on person notification emails (ADR 0123).
 * The token carries the person, the channel to drop, and the event, or no
 * event for a digest, which drops the channel from every event. No session
 * is required. Required channels refuse the change at apply time.
 */
import {
  personChannelSchema,
  personEventSchema,
  trimEndRun,
  type PersonChannel,
  type PersonEvent,
} from "@anygriddb/core";
import { sign, verify, type KeyRing } from "../auth/key-ring.js";

const USE = "notify-prefs" as const;

export type UnsubscribePayload = {
  userId: string;
  /** Null: every event that uses the channel (a digest's own link). */
  event: PersonEvent | null;
  channel: PersonChannel;
};

/**
 * Token put in the mail link: the payload, `~`, the signature, both
 * base64url. Not a dot: the server answers a path that ends like a file's
 * name with a 404.
 */
export function unsubscribeToken(
  ring: KeyRing,
  payload: UnsubscribePayload,
): string {
  const body = Buffer.from(
    JSON.stringify({
      u: payload.userId,
      ...(payload.event ? { e: payload.event } : {}),
      c: payload.channel,
    }),
    "utf8",
  ).toString("base64url");
  const signature = sign(ring, USE, body).toString("base64url");
  return `${body}~${signature}`;
}

export function readUnsubscribeToken(
  ring: KeyRing,
  token: string,
): UnsubscribePayload | null {
  const mark = token.indexOf("~");
  if (mark <= 0 || mark === token.length - 1) return null;
  const body = token.slice(0, mark);
  const signature = token.slice(mark + 1);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (!verify(ring, USE, body, given)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { u?: unknown; e?: unknown; c?: unknown };
    const userId =
      typeof parsed.u === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        parsed.u,
      )
        ? parsed.u
        : null;
    const event =
      parsed.e === undefined ? null : personEventSchema.safeParse(parsed.e);
    const channel = personChannelSchema.safeParse(parsed.c);
    if (!userId || event?.success === false || !channel.success) return null;
    if (channel.data === "in_app") return null;
    return { userId, event: event?.data ?? null, channel: channel.data };
  } catch {
    return null;
  }
}

export function unsubscribeUrl(
  publicUrl: string,
  ring: KeyRing,
  payload: UnsubscribePayload,
): string {
  return `${trimEndRun(publicUrl, "/")}/notify/unsubscribe/${unsubscribeToken(ring, payload)}`;
}
