"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { FilterSelect } from "@/components/list";
import { Empty, ErrorAlert, PageHead } from "@/components/ui";
import { api } from "@/lib/api";
import {
  dayLabel,
  describe,
  ipLabel,
  targetHref,
  type AuditKind,
  type AuditRow,
} from "@/lib/audit";
import { clockTime } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { ApiKey, Page } from "@/lib/types";

const PAGE_SIZE = 30;
const KINDS: { value: AuditKind | "all"; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "account", label: "Account" },
  { value: "api_key", label: "API keys" },
  { value: "endpoint", label: "Endpoints" },
  { value: "watch", label: "Watches" },
  { value: "event", label: "Webhooks" },
];
const ACTORS: { value: "all" | "session" | "api_key"; label: string }[] = [
  { value: "all", label: "Anyone" },
  { value: "session", label: "Dashboard" },
  { value: "api_key", label: "An API key" },
];

export function AuditItem({
  row,
  keyNames,
  compact,
}: {
  row: AuditRow;
  keyNames: Map<string, string>;
  compact?: boolean;
}) {
  const { title, tone, icon } = describe(row);
  const href = targetHref(row);
  const ip = ipLabel(row.ip);
  const keyName = row.apiKeyId ? keyNames.get(row.apiKeyId) : undefined;
  return (
    <li className={compact ? "au-row is-compact" : "au-row"}>
      <span className={`au-ico is-${tone}`} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="au-main">
        <div className="au-title">
          <b>{title}</b>
          {row.targetLabel &&
            (href ? (
              <Link className="au-target" href={href}>
                {row.targetLabel}
              </Link>
            ) : (
              <span className="au-target">{row.targetLabel}</span>
            ))}
        </div>
        {row.detail && <div className="au-detail">{row.detail}</div>}
      </div>
      <div className="au-meta">
        {row.actor === "api_key" ? (
          <span className="au-actor is-key">
            <Icon name="key" size={14} />
            {row.apiKeyId && keyName ? (
              <Link href={`/api-keys/view?id=${row.apiKeyId}`}>{keyName}</Link>
            ) : (
              "API key"
            )}
          </span>
        ) : (
          <span className="au-actor">
            <Icon name="layout" size={14} />
            Dashboard
          </span>
        )}
        <span className="au-time">
          {clockTime(row.at)}
          {ip && !compact ? ` · ${ip}` : ""}
        </span>
      </div>
    </li>
  );
}

function AuditList({ query }: { query: string }) {
  const first = useApi<Page<AuditRow>>(`/v1/audit-log?limit=${PAGE_SIZE}${query}`);
  const keys = useApi<{ data: ApiKey[] }>("/v1/api-keys");
  const [older, setOlder] = useState<{ rows: AuditRow[]; next: string | null }>();
  const more = useAction(async (cursor: string) => {
    const page = await api<Page<AuditRow>>(
      `/v1/audit-log?limit=${PAGE_SIZE}${query}&cursor=${encodeURIComponent(cursor)}`,
    );
    setOlder({ rows: [...(older?.rows ?? []), ...page.data], next: page.nextCursor });
  });

  if (first.error && !first.data)
    return (
      <ErrorAlert error={first.error} title="Couldn't load the audit log." onRetry={first.reload} />
    );
  if (!first.data) return <div aria-busy="true" style={{ minHeight: 240 }} />;

  const rows = [...first.data.data, ...(older?.rows ?? [])];
  const next = older ? older.next : first.data.nextCursor;
  const keyNames = new Map((keys.data?.data ?? []).map((key) => [key.id, key.name]));
  if (rows.length === 0) {
    return (
      <Empty icon="shield" title="Nothing here">
        {query
          ? "No changes match these filters."
          : "Changes to your keys, endpoints, watches and account will show here as they happen."}
      </Empty>
    );
  }

  // Rows arrive newest first; a new group starts whenever the day changes.
  const groups: { day: string; rows: AuditRow[] }[] = [];
  for (const row of rows) {
    const day = dayLabel(row.at);
    const last = groups.at(-1);
    if (last?.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }

  return (
    <>
      {groups.map((group) => (
        <section className="au-day" key={group.day} aria-label={group.day}>
          <h2>
            {group.day}
            <span>
              {group.rows.length} {group.rows.length === 1 ? "change" : "changes"}
            </span>
          </h2>
          <ul className="au-list">
            {group.rows.map((row) => (
              <AuditItem row={row} keyNames={keyNames} key={row.id} />
            ))}
          </ul>
        </section>
      ))}
      {more.error && <ErrorAlert error={more.error} title="Couldn't load older changes." />}
      {next ? (
        <div className="wh-row" style={{ justifyContent: "center" }}>
          <button
            className="wh-btn"
            type="button"
            disabled={more.pending}
            onClick={() => void more.run(next)}
          >
            <Icon name="clock" />
            {more.pending ? "Loading…" : "Show older"}
          </button>
        </div>
      ) : (
        <p className="fine" style={{ textAlign: "center" }}>
          That's everything{query ? " that matches" : ""}.
        </p>
      )}
    </>
  );
}

export default function AuditLogPage() {
  const [kind, setKind] = useState<AuditKind | "all">("all");
  const [actor, setActor] = useState<"all" | "session" | "api_key">("all");
  const [logins, setLogins] = useState(false);
  const query = `${kind === "all" ? "" : `&kind=${kind}`}${actor === "all" ? "" : `&actor=${actor}`}${logins ? "&logins=true" : ""}`;

  return (
    <>
      <PageHead
        back={{ href: "/settings", label: "Settings" }}
        title="Audit log"
        sub="Every change to your account: what changed, who made it and from where. Secrets are never recorded."
      />
      <div className="filters">
        <FilterSelect label="Show" value={kind} options={KINDS} onChange={setKind} />
        <FilterSelect label="Made by" value={actor} options={ACTORS} onChange={setActor} />
        <label className="wh-check" style={{ marginLeft: 4 }}>
          <input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} />
          Include logins
        </label>
      </div>
      {/* A new filter starts the list over, so "Show older" never mixes two queries. */}
      <AuditList query={query} key={query} />
    </>
  );
}
