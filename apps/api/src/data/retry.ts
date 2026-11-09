const RETRYABLE = new Set(["40P01", "40001"]);

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  if ("cause" in error) {
    return postgresCode(error.cause);
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Retries a transaction aborted by PostgreSQL deadlock or serialization failure. */
export async function withTransactionRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 200,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const code = postgresCode(error);
      if (!code || !RETRYABLE.has(code) || attempt > maxRetries) {
        throw error;
      }
      const jitter = Math.random() * 100;
      const wait = delay * 2 ** (attempt - 1) + jitter;
      await sleep(wait);
    }
  }
}
