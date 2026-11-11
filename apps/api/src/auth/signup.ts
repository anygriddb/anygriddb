import { labelSchema } from "@anygriddb/core";
import { z } from "zod";

export const signupInputSchema = z.object({
  email: z.email().max(254),
  displayName: labelSchema,
  password: z.string().min(12).max(128),
});

/** Proves the person before a second factor is replaced or a passkey added. */
export const factorProofSchema = z.object({
  password: z.string().min(1).max(128).optional(),
  factorCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const totpConfirmSchema = factorProofSchema.extend({
  secret: z
    .string()
    .regex(/^[A-Z2-7]+$/)
    .min(16)
    .max(128),
  code: z.string().regex(/^\d{6}$/),
});

export const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

export const backupCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/),
});
