import { z } from "zod";

const KEYS = ["source.plaintext", "notify.private_networks"] as const;

/** A requirement an administrator may relax (ADR 0140). */
export type RelaxationKey = (typeof KEYS)[number];

/**
 * What may be relaxed, and for what: the instance, or one source.
 * `consequence` is the version of what its confirmation says, raised when
 * it says more: a row keeps the one confirmed. Nothing else is relaxed:
 * a requirement whose risk falls on others than the administrator who
 * would relax it stays as it is.
 */
export const RELAXATIONS: Readonly<
  Record<
    RelaxationKey,
    { readonly scope: "instance" | "source"; readonly consequence: number }
  >
> = {
  /** One source connects without TLS (ADR 0139). */
  "source.plaintext": { scope: "source", consequence: 1 },
  /**
   * Administration's channels, heartbeats and collectors may call an HTTPS
   * address on a private network; loopback, link-local and cloud metadata
   * stay refused (ADR 0092, 0125).
   */
  "notify.private_networks": { scope: "instance", consequence: 1 },
};

export const relaxationKeySchema = z.enum(KEYS);

/**
 * Which relaxation, by its key and, for one kept for a source, the
 * source: given for one and only for one.
 */
export const relaxationSchema = z
  .object({ key: relaxationKeySchema, sourceId: z.uuid().optional() })
  .strict()
  .refine(
    (value) =>
      (RELAXATIONS[value.key].scope === "source") ===
      (value.sourceId !== undefined),
    { path: ["sourceId"] },
  );

export type RelaxationTarget = z.infer<typeof relaxationSchema>;
