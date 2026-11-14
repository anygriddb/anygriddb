import { i18n } from "@lingui/core";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@anygriddb/api/router";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { proofLink } from "./proof";

/**
 * The API serves this app on its own origin (ADR 0011): every call is a
 * relative URL, and the session cookie goes with it. Each call says the
 * language the app shows, so what the API names for the person (a new
 * table's grid, a copy) is in that language.
 */
const headers = () => (i18n.locale ? { "accept-language": i18n.locale } : {});

/**
 * Reads the database may take seconds to compute. A batch answers when its
 * slowest call has: sent with the others, each of these would hold back a
 * whole page, and a dashboard would show none of its widgets before its
 * heaviest one. They go out one request each.
 */
const SLOW_READS: ReadonlySet<string> = new Set([
  "dashboards.widgetData",
  "rows.aggregate",
]);

export function goesAlone(call: { type: string; path: string }): boolean {
  return call.type === "query" && SLOW_READS.has(call.path);
}

export function createClient() {
  return createTRPCClient<AppRouter>({
    links: [
      proofLink(),
      splitLink({
        condition: goesAlone,
        true: httpLink({ url: "/trpc", headers }),
        false: httpBatchLink({ url: "/trpc", maxURLLength: 6_000, headers }),
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

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
