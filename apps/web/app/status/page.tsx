"use client";

import type { statusResponse } from "@webhook/shared";
import Link from "next/link";
import { useEffect } from "react";
import type { z } from "zod";
import { TestnetBanner } from "@/components/banner";
import { Icon, Logo, type IconName } from "@/components/icons";
import { DOCS_URL } from "@/lib/constants";
import { clockTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";

type Status = z.infer<typeof statusResponse>;
type Component = Status["components"][number];
type Day = Component["days"][number];
interface Health {
  lastLedger: number | null;
  lagSeconds: number | null;
  dueDeliveries: number | null;
}

const REFRESH_MS = 60_000;

const OVERALL: Record<Status["status"], { tone: string; icon: IconName; title: string }> = {
  operational: { tone: "is-ok", icon: "check-circle", title: "All systems operational" },
  degraded: { tone: "is-warn", icon: "alert-triangle", title: "Some systems are slow" },
  outage: { tone: "is-bad", icon: "alert-circle", title: "We're having an outage" },
};
const STATE: Record<Component["status"], { tone: string; label: string }> = {
  operational: { tone: "is-ok", label: "Operational" },
  degraded: { tone: "is-warn", label: "Degraded" },
  outage: { tone: "is-bad", label: "Outage" },
};
const DAY: Record<Day["status"], { tone: string; label: string }> = {
  operational: { tone: "d-ok", label: "No downtime" },
  degraded: { tone: "d-slow", label: "Slow at times" },
  partial_outage: { tone: "d-partial", label: "Partial outage" },
  major_outage: { tone: "d-major", label: "Major outage" },
  no_data: { tone: "d-none", label: "No data" },
};
const LEGEND: Day["status"][] = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "no_data",
];

function dayLabel(date: string): string {
  const [year, month, day] = date.split("-");
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${parseInt(day ?? "", 10)} ${names[parseInt(month ?? "", 10) - 1] ?? ""} ${year}`;
}

function ComponentRow({ component }: { component: Component }) {
  const state = STATE[component.status];
  const measured = component.days.filter((d) => d.status !== "no_data").length;
  return (
    <div className="st-comp">
      <div className="top">
        <div>
          <b>{component.name}</b>
          <span>{component.description}</span>
        </div>
        <span className={`state ${state.tone}`}>{state.label}</span>
      </div>
      <div
        className="st-bars"
        role="img"
        aria-label={`${component.name}: ${component.uptimePercent === null ? "no uptime data yet" : `${component.uptimePercent}% uptime over ${measured} ${measured === 1 ? "day" : "days"} with data`}`}
      >
        {component.days.map((day) => (
          <i
            key={day.date}
            className={DAY[day.status].tone}
            title={`${dayLabel(day.date)} · ${DAY[day.status].label}${day.uptimePercent === null ? "" : ` · ${day.uptimePercent}% uptime`}`}
          />
        ))}
      </div>
      <div className="st-foot">
        <span>90 days ago</span>
        <hr />
        <span>
          {component.uptimePercent === null
            ? "no data yet"
            : `${component.uptimePercent.toFixed(2)} % uptime`}
        </span>
        <hr />
        <span>Today</span>
      </div>
    </div>
  );
}

/** The public status page: what is working now, and uptime day by day for the last 90 days. */
export default function StatusPage() {
  const status = useApi<Status>("/status");
  const health = useApi<Health>("/health");
  const reloadStatus = status.reload;
  const reloadHealth = health.reload;
  useEffect(() => {
    const timer = setInterval(() => {
      reloadStatus();
      reloadHealth();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reloadStatus, reloadHealth]);

  const data = status.data;
  const unreachable = status.error !== undefined && !data;
  const overall = unreachable
    ? { tone: "is-bad", icon: "alert-circle" as IconName, title: "We can't reach the service" }
    : data
      ? OVERALL[data.status]
      : { tone: "is-none", icon: "clock" as IconName, title: "Checking…" };
  const firstMeasured = data?.components
    .flatMap((c) => c.days.filter((d) => d.status !== "no_data").map((d) => d.date))
    .sort()[0];

  return (
    <>
      <TestnetBanner />
      <div className="st">
        <header className="st-head">
          <Link className="brand" href="/" aria-label="Webhook home" style={{ padding: 0 }}>
            <Logo />
            <span className="wordmark">webhook</span>
            <span className="st-word">status</span>
          </Link>
          <div className="wh-row">
            <a className="wh-btn is-sm is-ghost" href={DOCS_URL}>
              <Icon name="book" size={14} />
              Docs
            </a>
            <Link className="wh-btn is-sm" href="/overview">
              Dashboard
              <Icon name="arrow-right" size={14} />
            </Link>
          </div>
        </header>

        <div className={`st-banner ${overall.tone}`} role="status">
          <Icon name={overall.icon} size={24} />
          <h1>{overall.title}</h1>
          {data && <span className="when">checked {clockTime(data.updatedAt)}</span>}
        </div>

        {unreachable ? (
          <p className="hint" style={{ fontSize: 14 }}>
            The API didn't answer, so there is nothing to show yet. Payments that land meanwhile are
            not lost: every missed ledger is caught up in order once it is back.
          </p>
        ) : (
          data && (
            <>
              <div className="st-meta">
                <span>
                  Uptime over the past 90 days
                  {firstMeasured
                    ? `, measured every minute since ${dayLabel(firstMeasured)}.`
                    : ". Measuring starts with the first check."}
                </span>
              </div>
              <section className="st-list" aria-label="Components">
                {data.components.map((component) => (
                  <ComponentRow component={component} key={component.key} />
                ))}
              </section>
              <div className="st-legend" aria-hidden="true">
                {LEGEND.map((state) => (
                  <span key={state}>
                    <i className={DAY[state].tone} />
                    {DAY[state].label}
                  </span>
                ))}
              </div>
              {health.data && (
                <div className="result" role="status">
                  <span>
                    last ledger seen{" "}
                    <strong style={{ color: "var(--ink)" }}>{health.data.lastLedger ?? "—"}</strong>
                  </span>
                  {health.data.lagSeconds !== null && (
                    <span>{health.data.lagSeconds} s behind the network</span>
                  )}
                  {health.data.dueDeliveries !== null && (
                    <span>{health.data.dueDeliveries} webhooks waiting to send</span>
                  )}
                </div>
              )}
            </>
          )
        )}

        <footer className="st-links">
          <button
            className="wh-btn is-sm"
            type="button"
            onClick={() => {
              reloadStatus();
              reloadHealth();
            }}
          >
            <Icon name="rotate" size={14} />
            Check again
          </button>
          <a
            className="wh-btn is-sm is-ghost"
            href="https://status.stellar.org"
            target="_blank"
            rel="noopener"
          >
            <Icon name="external-link" size={14} />
            Stellar network status
          </a>
        </footer>
      </div>
    </>
  );
}
