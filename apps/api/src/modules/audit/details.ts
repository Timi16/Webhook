// One-line descriptions of what a change did, shown in the audit log. They are built from the
// validated request body of routes that carry no secrets (names, URLs, rules), never from
// passwords, keys or signing secrets.

type Body = Record<string, unknown>;
const isBody = (value: unknown): value is Body => typeof value === "object" && value !== null;
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const join = (parts: (string | undefined)[]): string | undefined => {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join(" · ").slice(0, 300) : undefined;
};

function expiry(value: unknown): string | undefined {
  if (value === null) return "never expires";
  return typeof value === "string" ? `expires ${value.slice(0, 10)}` : undefined;
}

export function apiKeyDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  return join([
    "scopes" in body ? `permissions: ${list(body.scopes).join(", ")}` : undefined,
    "allowedIps" in body
      ? list(body.allowedIps).length === 0
        ? "any IP allowed"
        : `allowed IPs: ${list(body.allowedIps).join(", ")}`
      : undefined,
    "expiresAt" in body ? expiry(body.expiresAt) : undefined,
    "note" in body ? "note updated" : undefined,
  ]);
}

export function apiKeyUpdateDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  return join([
    typeof body.name === "string" ? `renamed to "${body.name}"` : undefined,
    apiKeyDetail(body),
  ]);
}

export function endpointDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  return join([
    "eventTypes" in body ? `events: ${list(body.eventTypes).join(", ")}` : undefined,
    "description" in body ? "description updated" : undefined,
  ]);
}

export function endpointUpdateDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  return join([typeof body.url === "string" ? "URL changed" : undefined, endpointDetail(body)]);
}

const WATCH_FIELDS: Record<string, string> = {
  label: "name",
  endpointId: "endpoint",
  assets: "assets",
  amountRule: "amount rule",
  memoRule: "memo rule",
  senderAllowlist: "allowed senders",
  eventTypes: "events",
};

export function watchUpdateDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  const changed = Object.keys(WATCH_FIELDS).filter((field) => field in body);
  return changed.length > 0
    ? `changed: ${changed.map((f) => WATCH_FIELDS[f]).join(", ")}`
    : undefined;
}

export function watchCreateDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  const codes = Array.isArray(body.assets)
    ? body.assets
        .map((a) => (isBody(a) && typeof a.code === "string" ? a.code : ""))
        .filter(Boolean)
    : [];
  const rule = isBody(body.amountRule) ? body.amountRule.kind : undefined;
  return join([
    codes.length > 0 ? `accepts ${codes.join(", ")}` : undefined,
    typeof rule === "string" && rule !== "any" ? `amount rule: ${rule}` : undefined,
  ]);
}

export function profileDetail(body: unknown): string | undefined {
  if (!isBody(body)) return undefined;
  return join([
    typeof body.name === "string" ? `name: ${body.name}` : undefined,
    "workspace" in body
      ? body.workspace
        ? `workspace: ${String(body.workspace)}`
        : "workspace cleared"
      : undefined,
  ]);
}

export function emailChangeDetail(body: unknown): string | undefined {
  return isBody(body) && typeof body.email === "string" ? `to ${body.email}` : undefined;
}

export function replayDetail(_body: unknown, result: unknown): string | undefined {
  if (!isBody(result) || typeof result.requeued !== "number") return undefined;
  return `${result.requeued} ${result.requeued === 1 ? "delivery" : "deliveries"} queued again`;
}
