/**
 * Tells the instance that this page failed, so its operator learns of it
 * (`apps/api/src/client-errors.ts`). The page reports to the server it came
 * from, and nowhere else: what failed and on which page, never what the
 * person was looking at.
 *
 * A few reports per page at most, each failure once: a page that fails in
 * a loop says so once. A report that cannot be sent is dropped.
 */
import { TRPCClientError } from "@trpc/client";

export type FailureKind = "render" | "error" | "rejection";

export type FailureReport = {
  kind: FailureKind;
  message: string;
  stack?: string;
  path: string;
};

const MAX_REPORTS = 5;
const MAX_MESSAGE = 500;
const MAX_STACK = 6_000;

function post(report: FailureReport): void {
  void fetch("/api/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    // The page may be on its way out.
    keepalive: true,
  }).catch(() => undefined);
}

/** Makes a reporter with its own count of what it already told. */
export function failureReporter(
  send: (report: FailureReport) => void = post,
  path: () => string = () => window.location.pathname,
) {
  const told = new Set<string>();
  return function report(kind: FailureKind, cause: unknown): void {
    // A call the server refused, or could not be reached for, is not the
    // page failing: the server knows of the first, and nothing can be
    // sent during the second.
    if (cause instanceof TRPCClientError) return;
    const message = (
      cause instanceof Error ? cause.message : String(cause)
    ).slice(0, MAX_MESSAGE);
    // One failure may be seen twice: where it is caught, then by the
    // window. It is told once.
    if (told.size >= MAX_REPORTS || told.has(message)) return;
    told.add(message);
    const stack = cause instanceof Error ? cause.stack : undefined;
    send({
      kind,
      message,
      ...(stack ? { stack: stack.slice(0, MAX_STACK) } : {}),
      path: path(),
    });
  };
}

/** The page's reporter. */
export const reportFailure = failureReporter();

/** Reports what no code caught: an error thrown, a promise refused. */
export function reportUncaught(target: Window = window): void {
  target.addEventListener("error", (event) => {
    reportFailure("error", event.error ?? event.message);
  });
  target.addEventListener("unhandledrejection", (event) => {
    reportFailure("rejection", event.reason);
  });
}
