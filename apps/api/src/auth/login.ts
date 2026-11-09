import { labelSchema } from "@anygriddb/core";
import { z } from "zod";

export const loginInputSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});

export const signupInputSchema = z.object({
  email: z.email().max(254),
  displayName: labelSchema,
  password: z.string().min(12).max(128),
});

export const secondFactorSchema = z.object({
  code: z.string().trim().min(6).max(32),
});
