import { signPayload } from "../lib/hmac.js";

export const USER_AGENT = "Webhook/1.0";

export interface SignInput {
  eventId: string;
  attempt: number;
  /** Unix seconds at send time. */
  timestamp: number;
  /** The exact bytes that are sent; they are what gets signed. */
  rawBody: string;
  /** Current secret first; during a rotation grace window the previous one follows. */
  secrets: string[];
}

export function buildHeaders(input: SignInput): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "Webhook-Id": input.eventId, // same on every retry and resend
    "Webhook-Timestamp": String(input.timestamp),
    "Webhook-Attempt": String(input.attempt),
    "Webhook-Signature": input.secrets
      .map((secret) => `v1=${signPayload(secret, input.timestamp, input.rawBody)}`)
      .join(", "),
  };
}
