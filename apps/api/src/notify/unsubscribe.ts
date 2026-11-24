/**
 * Signed unsubscribe links on person notification emails (ADR 0126).
 * The token carries the person, the event, and the channel to drop; no
 * session is required. Required channels refuse the change at apply time.
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
  event: PersonEvent;
  channel: PersonChannel;
};

/** Token put in the mail link: payload.urlsafe.signature.urlsafe */
export function unsubscribeToken(
  ring: KeyRing,
  payload: UnsubscribePayload,
): string {
  const body = Buffer.from(
    JSON.stringify({
      u: payload.userId,
      e: payload.event,
      c: payload.channel,
    }),
    "utf8",
  ).toString("base64url");
  const signature = sign(ring, USE, body).toString("base64url");
  return `${body}.${signature}`;
}

export function readUnsubscribeToken(
  ring: KeyRing,
  token: string,
): UnsubscribePayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (!verify(ring, USE, body, given)) return null;
  // Constant-time length check already done inside verify; keep a local
  // compare of the decoded body length so a truncated token is refused.
  if (body.length < 8) return null;
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
    const event = personEventSchema.safeParse(parsed.e);
    const channel = personChannelSchema.safeParse(parsed.c);
    if (!userId || !event.success || !channel.success) return null;
    if (channel.data === "in_app") return null;
    return { userId, event: event.data, channel: channel.data };
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
