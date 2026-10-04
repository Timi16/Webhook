import type { ApiKey } from "./types";

export const SCOPES = [
  { value: "payments:read", label: "Read payments and webhook events" },
  { value: "watches:write", label: "Create, edit and pause watches" },
  { value: "endpoints:write", label: "Add endpoints, rotate secrets, resend and replay webhooks" },
] as const;

export type KeyStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

/** A rolled key carries its end date in revokedAt; until then it still works. */
export function keyState(key: ApiKey): { status: KeyStatus; endsAt: string | null } {
  const now = Date.now();
  if (key.revokedAt && new Date(key.revokedAt).getTime() <= now)
    return { status: "REVOKED", endsAt: null };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now)
    return { status: "EXPIRED", endsAt: null };
  return { status: "ACTIVE", endsAt: key.revokedAt };
}

/** "Full access", "Read only", or the permissions by name. */
export function accessLabel(scopes: string[]): string {
  if (SCOPES.every((scope) => scopes.includes(scope.value))) return "Full access";
  if (scopes.length === 1 && scopes[0] === "payments:read") return "Read only";
  return scopes.map((scope) => scope.split(":")[0]).join(" + ");
}
