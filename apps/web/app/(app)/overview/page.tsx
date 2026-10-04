"use client";

import Link from "next/link";
import { useRef } from "react";
import { Icon } from "@/components/icons";
import { Empty, ErrorAlert, PageHead, Skeleton, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { clockTime, duration, percent, relativeTime, shortAddress, shortUrl } from "@/lib/format";
import { useAction, useApi, useLiveStatus } from "@/lib/hooks";
import type { Endpoint, EventRow, Overview, Page, Watch } from "@/lib/types";

const STAT_LABELS = [
  "Payments detected · 24h",
  "Verified / rejected",
  "Webhook success",
  "Median delivery",
  "Active watches",
];
const CHART_HEIGHT = 128;

function change(total: number, previous: number): string {
  if (previous === 0) return total === 0 ? "none yesterday either" : "none the day before";
  const delta = Math.round(((total - previous) / previous) * 100);
  return `${delta >= 0 ? "+" : ""}${delta}% vs yesterday`;
}

function Stats({ overview }: { overview: Overview }) {
  const { payments, deliveries, watches } = overview;
  const finished = deliveries.delivered + deliveries.failed;
  return (
    <div className="wh-stats">
      <div className="wh-stat">
        <div className="lbl">{STAT_LABELS[0]}</div>
        <div className="val">
          {/* Re-keyed on every change so the count's tick animation replays. */}
          <span key={payments.total} className="tick a">
            {payments.total}
          </span>
        </div>
        <div className="sub">{change(payments.total, payments.previousTotal)}</div>
      </div>
      <div className="wh-stat">
        <div className="lbl">{STAT_LABELS[1]}</div>
        <div className="val">
          {payments.verified} / {payments.rejected}
        </div>
        <div className="sub">
          {percent(payments.verified, payments.verified + payments.rejected)} verified
        </div>
      </div>
      <div className="wh-stat">
        <div className="lbl">{STAT_LABELS[2]}</div>
        <div className="val">{percent(deliveries.delivered, finished)}</div>
        <div className="sub">
          {deliveries.retrying} retrying · {deliveries.failed} failed
        </div>
      </div>
      <div className="wh-stat">
        <div className="lbl">{STAT_LABELS[3]}</div>
        <div className="val">
          {deliveries.medianMs === null ? "—" : duration(deliveries.medianMs)}
        </div>
        <div className="sub">
          {deliveries.p95Ms === null ? "no deliveries yet" : `p95 ${duration(deliveries.p95Ms)}`}
        </div>
      </div>
      <div className="wh-stat">
        <div className="lbl">{STAT_LABELS[4]}</div>
        <div className="val">{watches.active}</div>
        <div className="sub">{watches.paused} paused</div>
      </div>
    </div>
  );
}

const hourLabel = (iso: string) => `${String(new Date(iso).getHours()).padStart(2, "0")}:00`;

function Chart({ hourly }: { hourly: Overview["hourly"] }) {
  const peak = Math.max(1, ...hourly.map((h) => h.verified + h.rejected));
  const verified = hourly.reduce((sum, h) => sum + h.verified, 0);
  const rejected = hourly.reduce((sum, h) => sum + h.rejected, 0);
  const axis = [0, 6, 12, 18].map((index) => hourly[index]).filter((h) => h !== undefined);
  return (
    <section className="wh-panel">
      <header>
        <span className="h">Payments per hour</span>
        <span className="legend">
          <span>
            <i style={{ background: "var(--ok)" }} />
            verified
          </span>
          <span>
            <i style={{ background: "var(--bad)" }} />
            rejected
          </span>
          <span>
            <i style={{ background: "var(--signal)" }} />
            this hour
          </span>
        </span>
      </header>
      <div
        className="chart"
        role="img"
        aria-label={`Payments per hour over the last 24 hours. ${verified} verified, ${rejected} rejected.`}
      >
        <div className="bars">
          {hourly.map((h, index) => {
            const total = h.verified + h.rejected;
            // Empty hours keep a hairline so the time axis stays readable.
            const height = total === 0 ? 2 : Math.max(4, Math.round((total / peak) * CHART_HEIGHT));
            return (
              <div
                key={h.hour}
                className={index === hourly.length - 1 ? "bar is-now" : "bar"}
                style={{ height, animationDelay: `${index * 25}ms` }}
                title={`${hourLabel(h.hour)} · ${h.verified} verified, ${h.rejected} rejected`}
              >
                <span className="ok" style={{ flex: `${h.verified} 1 0` }} />
                <span className="bad" style={{ flex: `${h.rejected} 1 0` }} />
              </div>
            );
          })}
        </div>
        <div className="axis">
          {axis.map((h, index) => (
            <span key={h.hour}>
              {index === 0 ? `${hourLabel(h.hour)} yesterday` : hourLabel(h.hour)}
            </span>
          ))}
          <span>now</span>
        </div>
      </div>
    </section>
  );
}

/** One line under the event type: what was paid, by whom, to which watch. */
function eventDetail(event: EventRow): string {
  const s = event.summary;
  if (!s) return event.type === "test.ping" ? "Test from dashboard" : "Stellar Testnet was reset";
  const watch = s.watchLabel ? ` · ${s.watchLabel}` : "";
  if (s.reasons.length > 0) return `${s.amount} ${s.assetCode} · ${s.reasons.join(", ")}${watch}`;
  return `${s.amount} ${s.assetCode} from ${shortAddress(s.from)}${watch}`;
}

function deliveryNote(event: EventRow): string {
  const d = event.deliveries[0];
  if (!d) return "";
  switch (d.status) {
    case "DELIVERED":
      return `${d.lastStatusCode ?? 200} on attempt ${d.attemptCount}`;
    case "RETRYING":
      return `attempt ${d.attemptCount}${d.nextAttemptAt ? ` · next ${relativeTime(d.nextAttemptAt)}` : ""}`;
    case "FAILED":
      return `${d.lastStatusCode ?? d.lastError ?? "failed"} after ${d.attemptCount} attempts`;
    case "CANCELLED":
      return "endpoint deleted";
    default:
      return "sending…";
  }
}

function Feed({ events }: { events: EventRow[] }) {
  const live = useLiveStatus();
  // Rows that were not in the previous render arrived live: tint them once.
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set(
    seen.current ? events.filter((e) => !seen.current?.has(e.id)).map((e) => e.id) : [],
  );
  seen.current = new Set(events.map((e) => e.id));

  return (
    <section className="wh-panel">
      <header>
        <span className="h">Live events</span>
        <span className="wh-row">
          <span className={live ? "wh-live" : "wh-live is-off"} role="status">
            <span className="dot" aria-hidden="true" />
            {live ? "Live" : "Reconnecting"}
          </span>
          <Link className="wh-btn is-sm is-ghost" href="/events">
            All events
          </Link>
        </span>
      </header>
      {events.length === 0 ? (
        <p className="panel-empty">
          No webhook events yet. They appear here the moment a payment arrives.
        </p>
      ) : (
        <ul className="feed">
          {events.map((event) => (
            <li key={event.id} className={fresh.has(event.id) ? "new-a" : undefined}>
              <Link href={`/events/view?id=${encodeURIComponent(event.id)}`}>
                <span className="t">{clockTime(event.createdAt)}</span>
                <span className="what">
                  <span className="type">{event.type}</span>
                  <span className="detail">{eventDetail(event)}</span>
                </span>
                <span className="wh-col" style={{ alignItems: "flex-end", gap: 2 }}>
                  {event.deliveries[0] && <StatusBadge status={event.deliveries[0].status} />}
                  <span className="wh-reason hide-sm">{deliveryNote(event)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Side({ endpoints, watches }: { endpoints: Endpoint[]; watches: Watch[] }) {
  return (
    <div className="stack">
      <section className="wh-panel">
        <header>
          <span className="h">Endpoint health</span>
          <Link className="wh-btn is-sm is-ghost" href="/endpoints">
            Manage
          </Link>
        </header>
        {endpoints.length === 0 ? (
          <p className="panel-empty">No endpoints yet.</p>
        ) : (
          <ul className="health">
            {endpoints.map((endpoint) => (
              <li key={endpoint.id}>
                <span className="url">{shortUrl(endpoint.url)}</span>
                <StatusBadge status={endpoint.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="wh-panel">
        <header>
          <span className="h">Watches</span>
          <Link className="wh-btn is-sm is-ghost" href="/watches">
            Manage
          </Link>
        </header>
        {watches.length === 0 ? (
          <p className="panel-empty">No watches yet.</p>
        ) : (
          <ul className="health">
            {watches.map((watch) => (
              <li key={watch.id}>
                <span className="wh-col" style={{ gap: 0 }}>
                  <span>{watch.label ?? "Untitled watch"}</span>
                  <span className="wh-reason">
                    {shortAddress(watch.walletAddress)} ·{" "}
                    {watch.assets.map((a) => a.code).join(", ")}
                  </span>
                </span>
                <StatusBadge status={watch.active ? "ACTIVE" : "PAUSED"} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Loading() {
  return (
    <>
      <div className="wh-stats" aria-hidden="true">
        {STAT_LABELS.map((label) => (
          <div className="wh-stat" key={label}>
            <div className="lbl">{label}</div>
            <Skeleton width="60%" height={24} />
            <div className="sub">
              <Skeleton width="80%" height={10} />
            </div>
          </div>
        ))}
      </div>
      <section className="wh-panel" aria-busy="true">
        <header>
          <span className="h">Payments per hour</span>
        </header>
        <div className="chart">
          <div className="bars">
            {Array.from({ length: 24 }, (_, index) => (
              <div className="bar" key={index} style={{ height: 20 + ((index * 37) % 90) }}>
                <span className="wh-skel" style={{ height: "100%", width: "100%" }} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

export default function OverviewPage() {
  const overview = useApi<Overview>("/v1/overview", ["payment.detected", "delivery.updated"]);
  const events = useApi<Page<EventRow>>("/v1/events?limit=6", [
    "payment.detected",
    "delivery.updated",
  ]);
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints", ["endpoint.updated"]);
  const watches = useApi<{ data: Watch[] }>("/v1/watches");

  const usable = endpoints.data?.data.filter((e) => e.status !== "DISABLED") ?? [];
  const testEndpoint = usable.length === 1 ? usable[0] : undefined;
  const test = useAction((id: string) =>
    api<{
      eventId: string;
      attempt: { statusCode: number | null; durationMs: number; error: string | null } | null;
    }>(`/v1/endpoints/${id}/test`, { method: "POST" }),
  );
  const sendTest = testEndpoint ? (
    <button
      className="wh-btn"
      type="button"
      disabled={test.pending}
      onClick={() => void test.run(testEndpoint.id).then(events.reload)}
    >
      <Icon name="send" />
      {test.pending ? "Sending…" : "Send test webhook"}
    </button>
  ) : (
    <Link className="wh-btn" href="/endpoints">
      <Icon name="send" />
      Send test webhook
    </Link>
  );

  const error = overview.error ?? events.error ?? endpoints.error ?? watches.error;
  const loaded =
    overview.data && events.data && endpoints.data && watches.data
      ? {
          overview: overview.data,
          events: events.data.data,
          endpoints: endpoints.data.data,
          watches: watches.data.data,
        }
      : undefined;
  const troubled = endpoints.data?.data.filter((e) => e.status !== "ACTIVE") ?? [];
  const firstTroubled = troubled[0];
  const isEmpty = loaded?.overview.payments.total === 0 && loaded.events.length === 0;

  return (
    <>
      <PageHead
        title="Overview"
        sub="Last 24 hours · Stellar Testnet"
        actions={
          <>
            {sendTest}
            <Link className="wh-btn is-primary" href="/watches/new">
              <Icon name="plus" />
              Create watch
            </Link>
          </>
        }
      />
      {test.error && <ErrorAlert error={test.error} title="The test webhook couldn't be sent." />}
      {error && !loaded ? (
        <ErrorAlert
          error={error}
          title="Couldn't load your overview."
          onRetry={() => {
            overview.reload();
            events.reload();
            endpoints.reload();
            watches.reload();
          }}
        />
      ) : !loaded ? (
        <Loading />
      ) : isEmpty ? (
        <Empty
          icon="inbox"
          title="No payments in the last 24 hours"
          actions={
            <>
              <Link className="wh-btn is-primary" href="/onboarding">
                <Icon name="list-checks" />
                Finish setup
              </Link>
              {sendTest}
            </>
          }
        >
          Finish setup to see live payments and deliveries here. Send a test webhook, then pay your
          watched wallet from any testnet account.
        </Empty>
      ) : (
        <>
          {firstTroubled && (
            <div className="wh-alert is-warn" role="alert">
              <Icon name="alert-triangle" />
              <div className="body">
                <strong>
                  {troubled.length === 1
                    ? "1 endpoint needs attention."
                    : `${troubled.length} endpoints need attention.`}
                </strong>{" "}
                <span className="mono">{shortUrl(firstTroubled.url)}</span>{" "}
                {firstTroubled.status === "DISABLED"
                  ? "is disabled, so nothing is being sent to it."
                  : "is failing. We're still retrying."}
              </div>
              <Link className="wh-btn is-sm" href="/endpoints">
                View endpoint
              </Link>
            </div>
          )}
          <Stats overview={loaded.overview} />
          <Chart hourly={loaded.overview.hourly} />
          <div className="cols-wide">
            <Feed events={loaded.events} />
            <Side endpoints={loaded.endpoints} watches={loaded.watches} />
          </div>
        </>
      )}
    </>
  );
}
