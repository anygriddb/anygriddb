import { z } from "zod";

export const loginInputSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});

export { signupInputSchema } from "./signup.js";
