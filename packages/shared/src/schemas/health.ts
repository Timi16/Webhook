import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.boolean(),
  lastLedger: z.number().int().nullable(),
  lagSeconds: z.number().int().nullable(),
  dueDeliveries: z.number().int().nullable(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
