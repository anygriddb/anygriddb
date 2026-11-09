import { i18n } from "@lingui/core";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@anygriddb/api/router";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

/**
 * The API serves this app on its own origin (ADR 0011): every call is a
 * relative URL, and the session cookie goes with it. Each call says the
 * language the app shows, so what the API names for the person (a new
 * table's grid, a copy) is in that language.
 */
export function createClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/trpc",
        maxURLLength: 6_000,
        headers: () => (i18n.locale ? { "accept-language": i18n.locale } : {}),
      }),
    ],
  });
}

/** The realtime socket, on the page's own host. */
export function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}

/** Imperative client, for event handlers that do not need React Query. */
export const trpc = createClient();

export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;

/** Stable message of a failed call, never a stack or SQL text. */
export function errorMessage(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return "Request rejected";
}
