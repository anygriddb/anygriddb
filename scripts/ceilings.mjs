/**
 * A ceiling declared outside the catalogue of limits
 * (`packages/core/src/limits.ts`, ADR 0132): a module's constant whose name
 * says a limit (`MAX_…`, `…_LIMIT`, `…_TTL_…`, `…_TIMEOUT_…`, `…_ATTEMPTS`,
 * `…_DAYS`…) and whose value is a number, or an object of numbers. A
 * constant that reads the catalogue (`ceilingOf(…)`) is not one.
 */
const NAME =
  /(?:^|_)(?:MAX|MIN|LIMITS?|CAP|BUDGET|TTL|TIMEOUT|ATTEMPTS|RETRIES|DAYS|HOURS|MINUTES)(?:_|$)/;
const DECLARATION = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b[^=]*=\s*/gm;

/** The initializer from `start`, to the `;` that ends it at its own depth. */
function initializer(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === ";" && depth === 0) return text.slice(start, index);
  }
  return text.slice(start);
}

/** Whether an initializer is made of numbers alone, or an object of them. */
function numeric(source) {
  const bare = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\bas const\b/g, "")
    .replace(/\b[a-z][A-Za-z0-9]*\s*:/g, "")
    .replace(/\b[A-Z][A-Z0-9_]*\b/g, "1");
  // A literal number of its own: what names another constant only is not
  // a new ceiling.
  return (
    /(?:^|[^A-Za-z_])\d/.test(
      source.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, "x"),
    ) &&
    /^[\s\d_.xXa-fA-F*+\-/(){},]*$/.test(
      bare.replace(/\b0x[0-9a-fA-F_]+\b/g, "1"),
    )
  );
}

/** The ceilings `text` declares, by name and line (from 1). */
export function ceilingsIn(text) {
  const found = [];
  for (const match of text.matchAll(DECLARATION)) {
    const name = match[1];
    if (!NAME.test(name)) continue;
    const start = match.index + match[0].length;
    if (!numeric(initializer(text, start))) continue;
    found.push({ name, line: text.slice(0, match.index).split("\n").length });
  }
  return found;
}

/** Why a constant that looks like a ceiling is not the catalogue's. */
const REASONS = {
  format:
    "a bound a format, a protocol or a store sets (a zip's, PostgreSQL's, a map's tiles, a barcode's, a regular expression's)",
  mechanics:
    "how the instance cuts up or paces its own work, never met as a limit (a batch, a cache's few seconds, a retry, a depth that guards a loop)",
  log: "the shape of one line of a log or a page's failure report",
  screen: "a screen's own measure",
  default: "a default an administrator changes, each source its own",
  apart:
    "the catalogue's value, written out in a process that reads nothing of the product, and held equal to it by its test",
};

/** The constants that look like ceilings and are not, each with why. */
export const CEILING_EXCEPTIONS = {
  "apps/api/src/automation-scripts/runner.ts:MAX_LOG_LINES": REASONS.apart,
  "apps/api/src/automation-scripts/runner.ts:MAX_LOG_LENGTH": REASONS.apart,
  "apps/api/src/automation-scripts/runner.ts:MAX_ERROR_LENGTH": REASONS.apart,
  "apps/api/src/client-errors.ts:MAX_STACK_LINES": REASONS.log,
  "apps/api/src/client-errors.ts:MAX_LINE_CHARS": REASONS.log,
  "apps/api/src/data/airtable-import.ts:RETRIES": REASONS.mechanics,
  "apps/api/src/data/conversion-job.ts:LOCK_ATTEMPTS": REASONS.mechanics,
  "apps/api/src/data/rows.ts:BUDGET_CHUNK_ROWS": REASONS.mechanics,
  "apps/api/src/data/zip.ts:LIMIT": REASONS.format,
  "apps/api/src/data/zip.ts:MAX_ENTRIES": REASONS.format,
  "apps/api/src/integrations/oidc.ts:CACHE_TTL_MS": REASONS.mechanics,
  "apps/api/src/integrations/saml.ts:CACHE_TTL_MS": REASONS.mechanics,
  "apps/api/src/integrations/smtp.ts:CACHE_TTL_MS": REASONS.mechanics,
  "apps/api/src/logged-error.ts:MAX_DEPTH": REASONS.log,
  "apps/api/src/process-log.ts:MAX_MESSAGE": REASONS.log,
  "apps/api/src/process-log.ts:MAX_STACK": REASONS.log,
  "apps/api/src/process-log.ts:MAX_URL": REASONS.log,
  "apps/api/src/read-budget.ts:BUDGET_STREAM_ROWS": REASONS.mechanics,
  "apps/api/src/realtime/bus.ts:MAX_PAYLOAD_BYTES": REASONS.format,
  "apps/api/src/settings.ts:GATE_TTL_MS": REASONS.mechanics,
  "apps/api/src/sources/sync.ts:EVENT_LIMIT": REASONS.mechanics,
  "apps/api/src/sources/watch.ts:WINDOW_LIMIT": REASONS.mechanics,
  "apps/api/src/sources/watch.ts:FUTURE_LIMIT": REASONS.mechanics,
  "apps/api/src/sources/watch.ts:EVENT_LIMIT": REASONS.mechanics,
  "apps/api/src/tls/listener.ts:HEAD_LIMIT": REASONS.format,
  "apps/web/components/fields/code-image.tsx:QR_MAX_CHARS": REASONS.format,
  "apps/web/components/grid/column-width.ts:MAX_FROM_LABEL": REASONS.screen,
  "apps/web/components/grid/use-rows.ts:MAX_ROWS_PER_READ": REASONS.mechanics,
  "apps/web/components/views/gallery-view.tsx:CARD_MIN": REASONS.screen,
  "apps/web/components/views/map-tiles.ts:MAX_LATITUDE": REASONS.format,
  "apps/web/components/views/map-tiles.ts:MAX_ZOOM": REASONS.format,
  "apps/web/components/views/map-tiles.ts:MIN_SPAN": REASONS.format,
  "apps/web/components/views/map-tiles.ts:MAX_TILES": REASONS.screen,
  "apps/web/lib/code128.ts:CODE128_MAX_CHARS": REASONS.format,
  "apps/web/lib/realtime-connection.ts:MAX_RETRY_MS": REASONS.mechanics,
  "apps/web/lib/report-failure.ts:MAX_REPORTS": REASONS.log,
  "apps/web/lib/report-failure.ts:MAX_MESSAGE": REASONS.log,
  "apps/web/lib/report-failure.ts:MAX_STACK": REASONS.log,
  "apps/web/lib/sidebar-width.ts:SIDEBAR_WIDTH_MIN": REASONS.screen,
  "apps/web/lib/sidebar-width.ts:SIDEBAR_WIDTH_MAX": REASONS.screen,
  "packages/core/src/automation.ts:CHAT_TEXT_MAX": REASONS.format,
  "packages/core/src/dashboards.ts:WIDGET_ROW_MAX": REASONS.screen,
  "packages/core/src/decimal.ts:MAX_DECIMAL_DIGITS": REASONS.format,
  "packages/core/src/query/digits.ts:MAX": REASONS.format,
  "packages/core/src/query/expressions.ts:MAX_STACK": REASONS.mechanics,
  "packages/core/src/query/regex.ts:MAX_GROUPS": REASONS.format,
  "packages/core/src/query/regex.ts:MAX_REPEAT": REASONS.format,
  "packages/core/src/query/write.ts:MAX_INSERT_PARAMS": REASONS.format,
  "packages/core/src/seen-cell.ts:MAX_EXPONENT": REASONS.format,
  "packages/core/src/sources.ts:DEFAULT_COPY_INTERVAL_MINUTES": REASONS.default,
};
