import { z } from "zod";
import { watchEventTypeSchema } from "./watch.js";

const description = z.string().trim().max(200).nullable().optional();

// Scheme, credential, port and SSRF rules are enforced by the API (they need DNS).
// Which payment events the endpoint accepts. A watch's own choice still applies on top.
const eventTypes = z
  .array(watchEventTypeSchema)
  .min(1, "event_type_required")
  .max(2)
  .transform((types) => [...new Set(types)])
  .optional();

export const createEndpointSchema = z.strictObject({
  url: z.string().min(1).max(2000),
  description,
  eventTypes,
});
export const updateEndpointSchema = z.strictObject({
  url: z.string().min(1).max(2000).optional(),
  description,
  eventTypes,
});
export const replayEndpointSchema = z.strictObject({ since: z.iso.datetime({ offset: true }) });
