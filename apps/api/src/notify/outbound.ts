import { AppError } from "@anygriddb/core";
import { outboundFailureText, requestOutbound } from "../outbound/index.js";

/** The most of a provider's answer kept: enough to say why it failed. */
const ANSWER_KEPT = 2_048;

export type OutboundRequest = {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string;
};

export type OutboundResponse = { status: number; body: string };

export type Outbound = (
  request: OutboundRequest,
  allowPrivate: boolean,
) => Promise<OutboundResponse>;

/**
 * What a channel's provider built, sent by the outbound service (ADR
 * 0125): a private address only where an administrator allowed private
 * networks, one redirect at most and on the same origin, and the answer
 * cut to the words shown when it failed.
 */
export async function sendOutbound(
  call: OutboundRequest,
  allowPrivate: boolean,
): Promise<OutboundResponse> {
  const answer = await requestOutbound({
    ...call,
    allowPrivate,
    maxBytes: ANSWER_KEPT,
    tooLarge: "cut",
  });
  return { status: answer.status, body: answer.body };
}

/**
 * A failure an administrator can read. The message of an unknown error
 * is not used: it often quotes the address, and some addresses are secrets.
 */
export function notifyFailureText(error: unknown): string {
  if (error instanceof AppError && error.code === "notify_needs_mail") {
    return "Mail is not configured";
  }
  if (error instanceof AppError && error.code === "invalid_notify_target") {
    return "Blocked target";
  }
  return outboundFailureText(error);
}
