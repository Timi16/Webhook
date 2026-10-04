"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { SystemPage } from "@/components/system";
import { useApi } from "@/lib/hooks";

interface Health {
  status: "ok" | "degraded";
  db: boolean;
  lastLedger: number | null;
  lagSeconds: number | null;
  dueDeliveries: number | null;
}

/** How the service is keeping up with testnet, read from the API's health check. */
export default function StatusPage() {
  const health = useApi<Health>("/health");
  const data = health.data;
  const unreachable = health.error !== undefined && !data;
  const slow = unreachable || data?.status === "degraded";

  return (
    <SystemPage
      code={slow ? "network delay" : "network status"}
      title={unreachable ? "We can't reach the service" : !data ? "Checking testnet…" : slow ? "Testnet is slow right now" : "Everything is keeping up"}
    >
      <p className="hint" style={{ fontSize: 14 }}>
        {unreachable
          ? "The API didn't answer. Payments that land meanwhile are not lost: every missed ledger is caught up in order once it is back."
          : slow
            ? "We're behind the network, so webhooks may arrive a few minutes late. Nothing is lost: every missed ledger is caught up in order."
            : "Payments are detected seconds after their ledger closes, and webhooks are going out on time."}
      </p>
      <div className="result" role="status">
        <span className={slow ? "wh-live is-warn" : "wh-live"}>
          <span className="dot" aria-hidden="true" />
          {unreachable ? "Unreachable" : !data ? "Checking…" : slow ? "Catching up…" : "Live"}
        </span>
        {data?.lastLedger != null && (
          <span>
            last ledger seen <strong style={{ color: "var(--ink)" }}>{data.lastLedger}</strong>
            {data.lagSeconds != null ? ` · ${data.lagSeconds} s behind` : ""}
          </span>
        )}
        {data?.dueDeliveries != null && <span>{data.dueDeliveries} webhooks queued</span>}
      </div>
      <div className="wh-row">
        <button className="wh-btn is-primary" type="button" onClick={health.reload}>
          <Icon name="rotate" />
          Check again
        </button>
        <a className="wh-btn" href="https://status.stellar.org" target="_blank" rel="noopener">
          <Icon name="external-link" />
          Stellar network status
        </a>
        <Link className="wh-btn is-ghost" href="/overview">
          Go to overview
        </Link>
      </div>
    </SystemPage>
  );
}
