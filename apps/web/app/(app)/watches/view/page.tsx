"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import { WithId } from "@/components/query";
import { TrustStatus } from "@/components/trust";
import { Amount, CopyButton, Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { useAccounts } from "@/lib/accounts";
import { api } from "@/lib/api";
import { dateTime, percent, shortAddress, shortUrl } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import { amountRuleLong, assetCodes, memoRuleLong } from "@/lib/rules";
import type { Endpoint, Page, PaymentRow, Watch, WatchStats } from "@/lib/types";

function WatchDetail({ id }: { id: string }) {
  const router = useRouter();
  const detail = useApi<{ watch: Watch; stats: WatchStats }>(`/v1/watches/${id}`, [
    "payment.detected",
  ]);
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const payments = useApi<Page<PaymentRow>>(`/v1/payments?watchId=${id}&limit=5`, [
    "payment.detected",
  ]);
  const watch = detail.data?.watch;
  const accounts = useAccounts(watch ? [watch.walletAddress] : []);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const toggle = useAction(async () => {
    await api(`/v1/watches/${id}/${watch?.active ? "pause" : "resume"}`, { method: "POST" });
    detail.reload();
  });
  const remove = useAction(async () => {
    await api(`/v1/watches/${id}`, { method: "DELETE" });
    router.replace("/watches");
  });

  if (detail.error && !watch) {
    return detail.error.status === 404 ? (
      <Empty
        icon="search"
        title="Watch not found"
        actions={
          <Link className="wh-btn" href="/watches">
            Back to watches
          </Link>
        }
      >
        It may have been deleted, or the link is wrong.
      </Empty>
    ) : (
      <ErrorAlert error={detail.error} title="Couldn't load this watch." onRetry={detail.reload} />
    );
  }
  if (!watch || !detail.data) return <div aria-busy="true" />;

  const label = watch.label ?? "Untitled watch";
  const stats = detail.data.stats;
  const endpoint = endpoints.data?.data.find((e) => e.id === watch.endpointId);
  const code = assetCodes(watch);
  const rows = payments.data?.data ?? [];
  const outcome = (p: PaymentRow) => p.matches.find((m) => m.watchId === id) ?? p.matches[0];

  return (
    <>
      <PageHead
        back={{ href: "/watches", label: "Watches" }}
        title={label}
        sub={`Watching ${shortAddress(watch.walletAddress)} since ${dateTime(watch.createdAt)}`}
        actions={
          <>
            <StatusBadge status={watch.active ? "ACTIVE" : "PAUSED"} />
            <button
              className="wh-btn"
              type="button"
              disabled={toggle.pending}
              onClick={() => void toggle.run()}
            >
              <Icon name={watch.active ? "pause" : "play"} />
              {watch.active ? "Pause" : "Resume"}
            </button>
            <Link className="wh-btn" href={`/watches/edit?id=${id}`}>
              <Icon name="pencil" />
              Edit
            </Link>
            <button className="wh-btn is-danger" type="button" onClick={() => setConfirming(true)}>
              <Icon name="trash" />
              Delete
            </button>
          </>
        }
      />
      {toggle.error && (
        <ErrorAlert
          error={toggle.error}
          title={`Couldn't ${watch.active ? "pause" : "resume"} this watch.`}
        />
      )}
      {!watch.active && (
        <div className="wh-alert is-neutral">
          <Icon name="pause" />
          <div className="body">
            <strong>This watch is paused.</strong> We still see payments to this wallet but don't
            verify them or send webhooks. Payments made while paused aren't replayed when you
            resume.
          </div>
        </div>
      )}
      <div className="cols-wide">
        <section className="stack">
          <h2 className="section-title">Configuration</h2>
          <dl className="wh-dl">
            <dt>Wallet</dt>
            <dd>
              {watch.walletAddress}{" "}
              <CopyButton value={watch.walletAddress} label="Copy wallet address" />
            </dd>
            <dt>Trustline</dt>
            <dd>
              <TrustStatus account={accounts.get(watch.walletAddress)} assets={watch.assets} />
            </dd>
            <dt>Asset</dt>
            <dd>
              {watch.assets.map((asset) => (
                <div key={`${asset.code}:${asset.issuer}`}>
                  {asset.code}{" "}
                  {asset.issuer && <span className="wh-reason">{shortAddress(asset.issuer)}</span>}
                </div>
              ))}
            </dd>
            <dt>Amount rule</dt>
            <dd>{amountRuleLong(watch.amountRule, code)}</dd>
            <dt>Memo rule</dt>
            <dd>{memoRuleLong(watch.memoRule)}</dd>
            <dt>Senders</dt>
            <dd>
              {watch.senderAllowlist.length === 0 ? (
                "anyone"
              ) : (
                <div className="chips">
                  {watch.senderAllowlist.map((sender) => (
                    <span className="wh-chip" key={sender}>
                      <span className="wh-chip-text" tabIndex={0} aria-label={`Sender ${sender}`}>
                        {shortAddress(sender)}
                      </span>
                      <span className="wh-tip" role="tooltip">
                        {sender}
                      </span>
                      <CopyButton value={sender} label="Copy sender" />
                    </span>
                  ))}
                </div>
              )}
            </dd>
            <dt>Webhooks</dt>
            <dd>{watch.eventTypes.join(", ")}</dd>
            <dt>Endpoint</dt>
            <dd>
              {endpoint ? (
                <Link href="/endpoints">{shortUrl(endpoint.url)}</Link>
              ) : (
                <span className="muted">deleted endpoint</span>
              )}
            </dd>
            <dt>Watch ID</dt>
            <dd>
              {watch.id} <CopyButton value={watch.id} label="Copy watch ID" />
            </dd>
            <dt>Created</dt>
            <dd>{dateTime(watch.createdAt)}</dd>
          </dl>
        </section>
        <section className="stack">
          <h2 className="section-title">Last 24 hours</h2>
          <div className="wh-stats" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <div className="wh-stat">
              <div className="lbl">Verified</div>
              <div className="val">{stats.verified24h}</div>
              <div className="sub">
                {percent(stats.verified24h, stats.verified24h + stats.rejected24h)}
              </div>
            </div>
            <div className="wh-stat">
              <div className="lbl">Rejected</div>
              <div className="val">{stats.rejected24h}</div>
              <div className="sub">
                {percent(stats.rejected24h, stats.verified24h + stats.rejected24h)}
              </div>
            </div>
          </div>
        </section>
      </div>
      <section className="stack">
        <div className="ph-row">
          <h2 className="section-title">Recent payments</h2>
          <Link className="wh-btn is-sm is-ghost" href={`/payments?watchId=${id}`}>
            All payments
            <Icon name="chevron-right" size={14} />
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="panel-empty">No payments to this wallet yet.</p>
        ) : (
          <div className="wh-resp">
            <table className="wh-table">
              <caption className="sr-only">Payments</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">From</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Memo</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const match = outcome(p);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link
                          className="rowlink"
                          href={`/payments/view?id=${encodeURIComponent(p.id)}`}
                        >
                          {dateTime(p.ledgerClosedAt)}
                        </Link>
                      </td>
                      <td>{shortAddress(p.from)}</td>
                      <td className="num">
                        <Amount amount={p.amount} code={p.asset.code} />
                      </td>
                      <td>{p.memo ?? <span className="muted">—</span>}</td>
                      <td style={{ paddingTop: 8, paddingBottom: 8 }}>
                        {match && <StatusBadge status={match.outcome} />}
                        {match && match.reasons.length > 0 && (
                          <div className="wh-reason">{match.reasons.join(", ")}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="wh-stack">
              {rows.map((p) => {
                const match = outcome(p);
                return (
                  <Link href={`/payments/view?id=${encodeURIComponent(p.id)}`} key={p.id}>
                    <div className="top">
                      <Amount amount={p.amount} code={p.asset.code} />
                      {match && <StatusBadge status={match.outcome} />}
                    </div>
                    <dl>
                      <dt>Time</dt>
                      <dd>{dateTime(p.ledgerClosedAt)}</dd>
                      <dt>From</dt>
                      <dd>{shortAddress(p.from)}</dd>
                      <dt>Memo</dt>
                      <dd>{p.memo ?? "—"}</dd>
                      {match && match.reasons.length > 0 && (
                        <>
                          <dt>Reason</dt>
                          <dd>{match.reasons.join(", ")}</dd>
                        </>
                      )}
                    </dl>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </section>
      {confirming && (
        <Modal
          title={`Delete ${label}?`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button
                className="wh-btn is-ghost"
                type="button"
                onClick={() => setConfirming(false)}
              >
                Keep watch
              </button>
              <button
                className="wh-btn is-danger"
                type="button"
                disabled={typed !== label || remove.pending}
                onClick={() => void remove.run()}
              >
                <Icon name="trash" />
                Delete watch
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            We'll stop watching <span className="mono">{shortAddress(watch.walletAddress)}</span>{" "}
            right away. Past payments and webhook events stay in your history. This can't be undone.
          </p>
          <div className="wh-field">
            <label htmlFor="confirm">Type the label to confirm</label>
            <input
              id="confirm"
              className="wh-input"
              placeholder={label}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {remove.error && <ErrorAlert error={remove.error} title="Couldn't delete this watch." />}
        </Modal>
      )}
    </>
  );
}

export default function WatchDetailPage() {
  return <WithId>{(id) => <WatchDetail id={id} />}</WithId>;
}
