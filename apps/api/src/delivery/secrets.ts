import type { Endpoint } from "@prisma/client";
import { z } from "zod";

/** Current secret plus at most this many previous ones are signed with. */
const MAX_PREVIOUS_SECRETS = 3;

export interface PreviousSecret {
  enc: string;
  until: Date;
}

const listSchema = z.array(z.object({ enc: z.string().min(1), until: z.iso.datetime() }));

type RotationFields = Pick<Endpoint, "secretEnc" | "prevSecretEnc" | "prevSecretUntil">;

/**
 * Previous secrets still inside their 24 h grace window. `prevSecretEnc` holds either one
 * encrypted secret (valid until `prevSecretUntil`) or, after overlapping rotations, a JSON list
 * of { enc, until }. Base64 never starts with "[", so the two forms cannot be confused.
 */
export function previousSecrets(endpoint: RotationFields, now: Date): PreviousSecret[] {
  if (!endpoint.prevSecretEnc || !endpoint.prevSecretUntil || endpoint.prevSecretUntil <= now)
    return [];
  if (!endpoint.prevSecretEnc.startsWith("[")) {
    return [{ enc: endpoint.prevSecretEnc, until: endpoint.prevSecretUntil }];
  }
  const parsed = listSchema.safeParse(JSON.parse(endpoint.prevSecretEnc));
  if (!parsed.success) return [];
  return parsed.data
    .map((s) => ({ enc: s.enc, until: new Date(s.until) }))
    .filter((s) => s.until > now);
}

/**
 * The columns to store when the current secret is replaced. Rotating again inside a grace
 * window keeps the earlier secrets valid until their own deadlines instead of dropping them.
 */
export function rotatedSecretFields(endpoint: RotationFields, now: Date, graceMs: number) {
  const kept: PreviousSecret[] = [
    { enc: endpoint.secretEnc, until: new Date(now.getTime() + graceMs) },
    ...previousSecrets(endpoint, now),
  ].slice(0, MAX_PREVIOUS_SECRETS);
  return {
    prevSecretEnc: JSON.stringify(kept.map((s) => ({ enc: s.enc, until: s.until.toISOString() }))),
    prevSecretUntil: new Date(Math.max(...kept.map((s) => s.until.getTime()))),
  };
}
