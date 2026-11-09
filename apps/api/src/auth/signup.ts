import { labelSchema } from "@anygriddb/core";
import { z } from "zod";

export const signupInputSchema = z.object({
  email: z.email().max(254),
  displayName: labelSchema,
  password: z.string().min(12).max(128),
});

export const totpConfirmSchema = z.object({
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
