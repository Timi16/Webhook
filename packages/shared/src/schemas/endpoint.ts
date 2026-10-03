import { z } from "zod";

const description = z.string().trim().max(200).nullable().optional();

// Scheme, credential, port and SSRF rules are enforced by the API (they need DNS).
export const createEndpointSchema = z.strictObject({
  url: z.string().min(1).max(2000),
  description,
});
export const updateEndpointSchema = z.strictObject({
  url: z.string().min(1).max(2000).optional(),
  description,
});
export const replayEndpointSchema = z.strictObject({ since: z.iso.datetime({ offset: true }) });
