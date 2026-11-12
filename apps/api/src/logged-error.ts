/**
 * What a log line keeps of an error: its kind, its code, the constraint
 * PostgreSQL names, where it was thrown, and the same of its cause. Never
 * its message nor any other property. A message quotes what failed (the
 * address a mail server refused, the row PostgreSQL would not take), and
 * a log outlives the data it speaks of.
 */
export type LoggedError = {
  type: string;
  code?: string;
  constraint?: string;
  stack?: string;
  cause?: LoggedError;
};

/** A name or a code: short, and made of nothing a value is made of. */
const TOKEN = /^[\w.:-]{1,64}$/;
const MAX_DEPTH = 3;

function token(source: object, name: string): string | undefined {
  const value: unknown = Reflect.get(source, name);
  if (typeof value === "number") return String(value);
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

/** The frames of a stack, without the message that heads it. */
function frames(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n").filter((line) => /^\s+at /.test(line));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function loggedError(error: unknown, depth = 0): LoggedError {
  if (error === null || typeof error !== "object") {
    return { type: typeof error };
  }
  const logged: LoggedError = {
    type: token(error, "name") ?? token(error.constructor, "name") ?? "Object",
  };
  const code = token(error, "code");
  if (code) logged.code = code;
  const constraint = token(error, "constraint");
  if (constraint) logged.constraint = constraint;
  const stack = frames(Reflect.get(error, "stack"));
  if (stack) logged.stack = stack;
  const cause: unknown = Reflect.get(error, "cause");
  if (cause !== undefined && cause !== null && depth < MAX_DEPTH) {
    logged.cause = loggedError(cause, depth + 1);
  }
  return logged;
}

/** The kind and the code in one line: what stands in for a message. */
function summary(logged: LoggedError): string {
  return logged.code ? `${logged.type} ${logged.code}` : logged.type;
}

/**
 * `loggedError` in the shape the server's logger asks of its `err`
 * serializer: `message` says the kind and the code again, and `stack` is
 * always a text.
 */
export function serializeError(
  error: unknown,
): LoggedError & { message: string; stack: string } {
  const logged = loggedError(error);
  return { ...logged, message: summary(logged), stack: logged.stack ?? "" };
}

/**
 * The fields of a log line that does not go through the server's logger
 * (the start, the queue): an error under `err` or `error` is kept as
 * `loggedError` keeps it, a text, a number or a flag as it is, and
 * nothing else.
 */
export function loggedFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "err" || key === "error") kept.err = loggedError(value);
    else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * The same failure without what it quoted, for code that prints or keeps
 * a thrown error's message on its own (the queue writes a failed task's
 * into its log line and its `last_error`).
 */
export function quietError(error: unknown): Error {
  const logged = loggedError(error);
  const quiet = new Error(summary(logged));
  quiet.name = "Failure";
  quiet.stack = `${quiet.name}: ${quiet.message}${logged.stack ? `\n${logged.stack}` : ""}`;
  return quiet;
}
