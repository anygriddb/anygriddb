import {
  AppError,
  publicError,
  type ErrorCode,
  type PublicError,
} from "@anygriddb/core";
import { isLoopback } from "./env.js";

type HeaderReply = {
  header: (name: string, value: string) => void;
};

type FailureLog = {
  error: (object: Record<string, unknown>, message: string) => void;
  info: (object: Record<string, unknown>, message: string) => void;
};

/**
 * A failed request in the log: a fault of the server (5xx) as an error,
 * with its stack; a refused request (4xx: a rate limit, a bad input, a
 * missing right) on one info line, so a client hammering a limit does not
 * flood the errors an operator alerts on.
 */
export function logFailure(
  log: FailureLog,
  failure: {
    error: unknown;
    status: number;
    message: string;
    context?: Record<string, unknown>;
  },
): void {
  if (failure.status >= 500) {
    log.error({ ...failure.context, err: failure.error }, failure.message);
    return;
  }
  log.info({ ...failure.context, status: failure.status }, failure.message);
}

/**
 * Whether a request under `/trpc` uses a method no procedure answers. A
 * query is a GET and a mutation a POST; HEAD asks only whether one
 * answers. The adapter builds a web request out of any other, which
 * cannot carry some of them (TRACE): refused before it, such a method is
 * the caller's mistake and not a fault of the server.
 */
export function unservedProcedureMethod(request: {
  method: string;
  url: string;
}): boolean {
  return (
    request.url.startsWith("/trpc/") &&
    !["GET", "POST", "HEAD"].includes(request.method)
  );
}

/**
 * An answer that the instance cannot give for now (under maintenance, too
 * many large reads at once, a read past its time limit) says when to ask
 * again, unless its route already did. An adapter may hand its answer
 * whole, as a web `Response`: the reply takes its status only once sent.
 */
export function sayWhenToRetry(
  reply: HeaderReply & {
    statusCode: number;
    hasHeader: (name: string) => boolean;
  },
  answer?: unknown,
): void {
  const status = answer instanceof Response ? answer.status : reply.statusCode;
  const said =
    reply.hasHeader("retry-after") ||
    (answer instanceof Response && answer.headers.has("retry-after"));
  if (status === 503 && !said) reply.header("Retry-After", "30");
}

/** Removes line breaks so a user value cannot forge extra log lines. */
export function stripCrlf(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, "");
}

export function applyApiSecurityHeaders(
  reply: HeaderReply,
  hsts: boolean,
): void {
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  if (hsts) {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

type OriginRequest = {
  method: string;
  url: string;
  headers: {
    origin?: string | string[];
    host?: string;
    cookie?: string;
    upgrade?: string;
  };
};

/**
 * Whether a request rides a person's session from a page that is not the
 * app's own. A browser names the page a write or a socket comes from
 * (`Origin`), and no page can change what it says. The session cookie is
 * kept to this host and to requests of its own site (`__Host-`,
 * `SameSite=Strict`), which stops another site; a page of the same site,
 * on another name or another port, still sends it. So a write, or a
 * socket, that carries the session must come from the address it was sent
 * to, or from the one people are told to open (`PUBLIC_URL`).
 *
 * Left alone: a read, which answers nothing a page of another origin can
 * see; a request with no `Origin`, which is no browser's page and is asked
 * who it is by what follows; one without the session; and the answer an
 * identity provider posts back (`exempt`), which is checked by its
 * signature.
 */
export function foreignSessionWrite(
  request: OriginRequest,
  input: {
    sessionCookie: string;
    publicUrl: string;
    exempt: readonly string[];
  },
): boolean {
  const socket = request.headers.upgrade?.toLowerCase() === "websocket";
  if (!socket && ["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return false;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  const carried = (request.headers.cookie ?? "")
    .split(";")
    .some((part) => part.trim().startsWith(`${input.sessionCookie}=`));
  if (!carried) return false;
  const path = request.url.split("?")[0] ?? "";
  if (input.exempt.includes(path)) return false;
  // Sent twice, or as `null` (a sandboxed page): not the app's own.
  if (typeof origin !== "string" || !URL.canParse(origin)) return true;
  const from = new URL(origin);
  const told = new URL(input.publicUrl);
  if (from.origin === told.origin) return false;
  // The development server, plain HTTP on this machine: by any of its
  // names. Anywhere else `PUBLIC_URL` is https (`readEnv`).
  if (told.protocol === "http:" && isLoopback(from.hostname)) return false;
  // The address the request was sent to names no scheme: AnyGridDB itself
  // serves HTTPS only (ADR 0029), so a page it served is an https one.
  return from.protocol !== "https:" || from.host !== request.headers.host;
}

export function publicErrorStatus(statusCode: number | undefined): number {
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  return 500;
}

/**
 * HTTP status and public body for any thrown value on a Fastify route:
 * AppError keeps its code; Fastify 4xx keep their status; everything else
 * is an internal error.
 */
export function replyFromError(error: unknown): {
  status: number;
  body: ReturnType<typeof publicErrorBody>;
} {
  if (error instanceof AppError) {
    return { status: error.status, body: errorBody(publicError(error)) };
  }
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  const status = publicErrorStatus(statusCode);
  return { status, body: publicErrorBody(status) };
}

function codeFor(status: number): ErrorCode {
  if (status >= 500) return "internal_error";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 413) return "file_too_large";
  return "request_rejected";
}

/** A failure as every HTTP route sends it (ADR 0013). */
function errorBody(failure: PublicError): {
  error: string;
  code: ErrorCode;
  detail?: string;
} {
  return {
    error: failure.message,
    code: failure.code,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  };
}

/** A refusal with a status, and a code when one says more than the status. */
export function publicErrorBody(status: number, code?: ErrorCode) {
  return errorBody(publicError(new AppError(code ?? codeFor(status))));
}

type FormApp = {
  addContentTypeParser: (
    type: string,
    options: { parseAs: "string" },
    parser: (
      request: unknown,
      body: string | Buffer,
      done: (error: Error | null, body?: unknown) => void,
    ) => void,
  ) => unknown;
};

/**
 * Takes a form's body (`application/x-www-form-urlencoded`) as an object
 * of its fields: what an identity provider posts back, and what an
 * application sends for a token.
 */
export function acceptFormBodies(app: FormApp): void {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
}
