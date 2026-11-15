import { z } from "zod";
import { INSTANCE_EVENT_TYPES } from "@anygriddb/core";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^\P{Cc}*$/u);

const eventsSchema = z
  .array(z.enum(INSTANCE_EVENT_TYPES))
  .max(INSTANCE_EVENT_TYPES.length);

const schedulesSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/** A JSON object an administrator typed. The provider schema checks it. */
const bagSchema = z.record(z.string().max(40), z.unknown());

export const createIntegrationSchema = z
  .object({
    provider: z.string().trim().min(1).max(40),
    name: nameSchema,
    events: eventsSchema,
    schedules: schedulesSchema.optional(),
    config: bagSchema,
    secrets: bagSchema,
  })
  .strict();

export const updateIntegrationSchema = z
  .object({
    id: z.uuid(),
    name: nameSchema.optional(),
    events: eventsSchema.optional(),
    schedules: schedulesSchema.optional(),
    config: bagSchema.optional(),
    secrets: bagSchema.optional(),
  })
  .strict();

export const integrationIdSchema = z.object({ id: z.uuid() }).strict();

export const integrationEnabledSchema = z
  .object({ id: z.uuid(), enabled: z.boolean() })
  .strict();
