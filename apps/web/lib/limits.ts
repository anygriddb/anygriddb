/**
 * What a client's engine computes differently, said to the person who
 * builds the field (ADR 0027): in one sentence, naming the engine, since
 * the limit is the engine's and the formula runs anyway.
 */
import { limitKey, type DialectName, type SourceLimit } from "@anygriddb/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useCallback } from "react";

export const ENGINE_NAMES: Record<DialectName, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlserver: "SQL Server",
  oracle: "Oracle",
};

const APPROXIMATE = msg`${{ engine: "" }} computes ${{ fn: "" }} approximately: the result is right to 15 digits. This is a limit of ${{ engine: "" }}.`;
const PRECISION = msg`${{ engine: "" }} keeps at most 38 digits in a number: this calculation may be rounded. This is a limit of ${{ engine: "" }}.`;
const REGEX = msg`With an alternative (|) or a lazy repeat (*?), ${{ engine: "" }} keeps the first match and PostgreSQL the longest: ${{ fn: "" }} may find another text. This is a ${{ engine: "" }} limit.`;

const SENTENCES = {
  approximate: APPROXIMATE,
  precision: PRECISION,
  regex: REGEX,
};

/** Each limit once, whatever the number of places that meet it. */
export function distinctLimits<T extends SourceLimit>(
  limits: readonly T[],
): T[] {
  const seen = new Map<string, T>();
  for (const limit of limits) {
    const key = limitKey(limit);
    if (!seen.has(key)) seen.set(key, limit);
  }
  return [...seen.values()];
}

export function useLimitText(): (limit: SourceLimit) => string {
  const { i18n } = useLingui();
  return useCallback(
    (limit: SourceLimit) =>
      i18n._({
        ...SENTENCES[limit.code],
        values: { engine: ENGINE_NAMES[limit.engine], fn: limit.fn ?? "" },
      }),
    [i18n],
  );
}
