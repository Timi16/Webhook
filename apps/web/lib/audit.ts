import type { IconName } from "@/components/icons";

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  detail: string | null;
  actor: "session" | "api_key";
  apiKeyId: string | null;
  ip: string | null;
}

export type AuditKind = "account" | "api_key" | "endpoint" | "watch" | "event";
type Tone = "ok" | "warn" | "bad" | "neutral";

/** How each action reads, and how much attention it deserves. */
const ACTIONS: Record<string, { title: string; tone: Tone }> = {
  "account.created": { title: "Account created", tone: "ok" },
  "account.email_verified": { title: "Email confirmed", tone: "ok" },
  "account.logged_in": { title: "Logged in", tone: "neutral" },
  "account.login_failed": { title: "Login failed: wrong password", tone: "bad" },
  "account.profile_updated": { title: "Profile updated", tone: "neutral" },
  "account.password_changed": { title: "Password changed", tone: "warn" },
  "account.password_reset": { title: "Password reset by email link", tone: "warn" },
  "account.email_change_requested": { title: "Email change requested", tone: "warn" },
  "account.email_changed": { title: "Email changed", tone: "warn" },
  "api_key.created": { title: "API key created", tone: "ok" },
  "api_key.updated": { title: "API key updated", tone: "neutral" },
  "api_key.rolled": { title: "API key rolled", tone: "warn" },
  "api_key.revoked": { title: "API key revoked", tone: "bad" },
  "api_key.deleted": { title: "API key deleted", tone: "bad" },
  "endpoint.created": { title: "Endpoint added", tone: "ok" },
  "endpoint.updated": { title: "Endpoint updated", tone: "neutral" },
  "endpoint.deleted": { title: "Endpoint deleted", tone: "bad" },
  "endpoint.secret_rotated": { title: "Signing secret rotated", tone: "warn" },
  "endpoint.enabled": { title: "Endpoint re-enabled", tone: "ok" },
  "endpoint.replayed": { title: "Failed webhooks replayed", tone: "neutral" },
  "watch.created": { title: "Watch created", tone: "ok" },
  "watch.updated": { title: "Watch updated", tone: "neutral" },
  "watch.paused": { title: "Watch paused", tone: "warn" },
  "watch.resumed": { title: "Watch resumed", tone: "ok" },
  "watch.deleted": { title: "Watch deleted", tone: "bad" },
  "event.resent": { title: "Webhook resent", tone: "neutral" },
};

const ICONS: Record<AuditKind, IconName> = {
  account: "shield",
  api_key: "key",
  endpoint: "webhook",
  watch: "eye",
  event: "send",
};

export const kindOf = (action: string) => (action.split(".")[0] ?? "account") as AuditKind;

export function describe(row: AuditRow): { title: string; tone: Tone; icon: IconName } {
  const known = ACTIONS[row.action];
  return {
    title: known?.title ?? row.action,
    tone: known?.tone ?? "neutral",
    icon: ICONS[kindOf(row.action)] ?? "info",
  };
}

/** Where the thing that changed lives, if it still exists. */
export function targetHref(row: AuditRow): string | undefined {
  if (!row.targetId || /\.(deleted)$/.test(row.action)) return undefined;
  switch (kindOf(row.action)) {
    case "api_key":
      return `/api-keys/view?id=${row.targetId}`;
    case "endpoint":
      return "/endpoints";
    case "watch":
      return `/watches/view?id=${row.targetId}`;
    case "event":
      return `/events/view?id=${row.targetId}`;
    default:
      return undefined;
  }
}

/** "::1" and "127.0.0.1" mean the request came from the same machine as the API. */
export function ipLabel(ip: string | null): string | null {
  if (!ip) return null;
  return ip === "::1" || ip.startsWith("127.") ? "this machine" : ip;
}

/** "Today", "Yesterday" or the date, for grouping rows by day. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const month = date.toLocaleString("en-GB", { month: "short" });
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}
