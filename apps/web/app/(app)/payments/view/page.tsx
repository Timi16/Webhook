"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { WithId } from "@/components/query";
import { CurlButton } from "@/components/curl";
import {
  Amount,
  CopyButton,
  Empty,
  ErrorAlert,
  ExplorerLink,
  PageHead,
  StatusBadge,
} from "@/components/ui";
import { explorer } from "@/lib/explorer";
import { clockTime, dateTime, shortAddress, shortUrl } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { amountRuleLong, assetCodes, memoRuleLong } from "@/lib/rules";
import type { Endpoint, PaymentDetail, Watch } from "@/lib/types";

type Match = PaymentDetail["matches"][number];

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

/** The four checks of one watch, each with the rule it was checked against. */
function ruleLines(payment: PaymentDetail, match: Match, watch: Watch | undefined) {
  const noAllowlist = watch !== undefined && watch.senderAllowlist.length === 0;
  return [
    {
      name: "Asset",
      rule: watch ? `ASSET ${assetCodes(watch)}` : "ASSET",
      note: watch ? `watch accepts ${assetCodes(watch)}` : "",
      value: `${payment.asset.code}${payment.asset.issuer ? ` · ${shortAddress(payment.asset.issuer)}` : ""}`,
      check: match.checks.asset,
      skipped: false,
    },
    {
      name: "Amount",
      rule: watch ? amountRuleLong(watch.amountRule, "").trim().toUpperCase() : "AMOUNT",
      note: watch ? `rule is ${amountRuleLong(watch.amountRule, payment.asset.code)}` : "",
      value: `${payment.amount} ${payment.asset.code}`,
      check: match.checks.amount,
      skipped: false,
    },
    {
      name: "Memo",
      rule: watch ? memoRuleLong(watch.memoRule).toUpperCase() : "MEMO",
      note: watch ? `rule is ${memoRuleLong(watch.memoRule)}` : "",
      value: payment.memo ?? "none",
      check: match.checks.memo,
      skipped: false,
    },
    {
      name: "Sender",
      rule: "SENDER",
      note: noAllowlist
        ? "no allowlist set"
        : watch
          ? `${watch.senderAllowlist.length} allowed`
          : "",
      value: shortAddress(payment.from),
      check: match.checks.sender,
      skipped: noAllowlist,
    },
  ];
}

function MatchPanels({
  payment,
  match,
  watch,
  endpoints,
}: {
  payment: PaymentDetail;
  match: Match;
  watch: Watch | undefined;
  endpoints: Endpoint[];
}) {
  const lines = ruleLines(payment, match, watch);
  const checked = lines.filter((l) => !l.skipped);
  const failed = checked.filter((l) => !l.check.passed).length;
  const verified = match.outcome === "VERIFIED";
  const delivery = match.event?.deliveries[0];
  const endpoint = watch ? endpoints.find((e) => e.id === watch.endpointId) : undefined;

  return (
    <>
      <div className="rcpt-wrap">
        <div className="rcpt" aria-label={`Receipt for payment ${payment.id}`}>
          <div className="c">
            <b>Payment receipt</b>
            <br />
            {match.watchLabel ?? "Watch"}
          </div>
          <span className={verified ? "stamp ok" : "stamp"} aria-hidden="true">
            {verified ? "Verified" : "Rejected"}
          </span>
          <hr />
          <div className="r">
            <span>LEDGER</span>
            <span>{payment.ledger}</span>
          </div>
          <div className="r">
            <span>CLOSED</span>
            <span>{payment.ledgerClosedAt.slice(11, 19)} UTC</span>
          </div>
          <div className="r">
            <span>FROM</span>
            <span>{shortAddress(payment.from)}</span>
          </div>
          <div className="r">
            <span>TO</span>
            <span>
              {match.watchLabel ? `${match.watchLabel} · ` : ""}
              {shortAddress(payment.to)}
            </span>
          </div>
          <div className="r">
            <span>MEMO</span>
            <span>{payment.memo ?? "none"}</span>
          </div>
          <hr />
          {lines.map((line) => (
            <div className="r" key={line.name}>
              <span>{line.rule}</span>
              {line.skipped ? (
                <span style={{ color: "var(--ink-muted)" }}>SKIPPED</span>
              ) : (
                <span className={line.check.passed ? "pass" : "fail"}>
                  {line.check.passed ? "PASS" : "FAIL"}
                </span>
              )}
            </div>
          ))}
          <hr className="dbl" />
          <div className="total">
            <span>TOTAL</span>
            <span>
              {payment.amount} <small>{payment.asset.code}</small>
            </span>
          </div>
          <hr />
          {match.reasons.length > 0 && (
            <div className="c">
              <span className="hl">REASON {match.reasons.join(" · ")}</span>
            </div>
          )}
          <div className="c" style={{ marginTop: 8, fontSize: 11 }}>
            {match.event && delivery
              ? `Webhook ${match.event.type} · ${delivery.status.toLowerCase()}`
              : "No webhook for this result"}
          </div>
        </div>
      </div>
      <section className="wh-panel">
        <header>
          <span className="h">Rule check</span>
          <span className="wh-reason">
            {failed === 0
              ? `all ${checked.length} checked rules passed`
              : `${failed} of ${checked.length} checked rules failed`}
          </span>
        </header>
        <dl className="wh-dl is-plain">
          {lines.map((line) => (
            <div key={line.name} style={{ display: "contents" }}>
              <dt>{line.name}</dt>
              <dd style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {line.skipped ? (
                  <span className="wh-badge is-neutral">
                    <Icon name="minus" size={14} className="ic-b" />
                    skipped
                  </span>
                ) : line.check.passed ? (
                  <span className="wh-badge is-ok">
                    <Icon name="check" size={14} className="ic-b" />
                    pass
                  </span>
                ) : (
                  <span className="wh-badge is-bad">
                    <Icon name="x" size={14} className="ic-b" />
                    fail
                  </span>
                )}
                <span>{line.value}</span>
                {line.note && <span className="muted">{line.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="wh-summary">
          reasons: <b>{JSON.stringify(match.reasons)}</b>
        </div>
      </section>
      <section className="wh-panel">
        <header>
          <span className="h">Webhook event</span>
          {delivery && <StatusBadge status={delivery.status} />}
        </header>
        <div className="panel-body">
          {match.event ? (
            <>
              <div className="wh-row" style={{ justifyContent: "space-between" }}>
                <Link
                  className="mono"
                  href={`/events/view?id=${encodeURIComponent(match.event.id)}`}
                >
                  {match.event.id}
                </Link>
                <span className="code-chip">{match.event.type}</span>
              </div>
              {delivery && (
                <div className="fine">
                  {delivery.attemptCount} {delivery.attemptCount === 1 ? "attempt" : "attempts"}
                  {delivery.deliveredAt ? ` · delivered at ${clockTime(delivery.deliveredAt)}` : ""}
                  {endpoint ? ` · ${shortUrl(endpoint.url)}` : ""}
                </div>
              )}
            </>
          ) : (
            <p className="hint">
              No webhook was sent: this watch only sends{" "}
              <span className="mono">payment.received</span>. Turn on{" "}
              <span className="mono">payment.rejected</span> in the watch to hear about payments
              like this one.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function PaymentView({ id }: { id: string }) {
  const detail = useApi<{ payment: PaymentDetail }>(`/v1/payments/${encodeURIComponent(id)}`, [
    "delivery.updated",
  ]);
  const watches = useApi<{ data: Watch[] }>("/v1/watches");
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const payment = detail.data?.payment;

  if (detail.error && !payment) {
    return detail.error.status === 404 ? (
      <Empty
        icon="search"
        title="Payment not found"
        actions={
          <Link className="wh-btn" href="/payments">
            Back to payments
          </Link>
        }
      >
        The link may be wrong, or the payment belongs to another account.
      </Empty>
    ) : (
      <ErrorAlert
        error={detail.error}
        title="Couldn't load this payment."
        onRetry={detail.reload}
      />
    );
  }
  if (!payment) return <div aria-busy="true" />;

  const first = payment.matches[0];
  const watchFor = (match: Match) => watches.data?.data.find((w) => w.id === match.watchId);
  const tx = explorer.tx(payment.txHash);

  return (
    <>
      <PageHead
        back={{ href: "/payments", label: "Payments" }}
        title={<Amount amount={payment.amount} code={payment.asset.code} large />}
        sub={`Received ${dateTime(payment.ledgerClosedAt)}${first?.watchLabel ? ` · to ${first.watchLabel}` : ""}`}
        actions={
          <>
            {first && <StatusBadge status={first.outcome} />}
            <CurlButton path={`/v1/payments/${encodeURIComponent(payment.id)}`} />
            <a className="wh-btn" href={tx} target="_blank" rel="noopener">
              <Icon name="external-link" />
              View on stellar.expert
            </a>
          </>
        }
      />
      <div className="cols-wide">
        <section className="stack">
          <h2 className="section-title">Details</h2>
          <dl className="wh-dl">
            <dt>Payment ID</dt>
            <dd>
              {payment.id} <CopyButton value={payment.id} label="Copy payment ID" />
            </dd>
            {first && (
              <>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={first.outcome} />
                </dd>
              </>
            )}
            {first && first.reasons.length > 0 && (
              <>
                <dt>Reasons</dt>
                <dd>
                  <span className="chips">
                    {first.reasons.map((reason) => (
                      <span className="code-chip" key={reason}>
                        {reason}
                      </span>
                    ))}
                  </span>
                </dd>
              </>
            )}
            <dt>Wallet</dt>
            <dd>
              {payment.to} <CopyButton value={payment.to} label="Copy wallet address" />
              <ExplorerLink address={payment.to} />
              {first?.watchLabel && <div className="wh-reason">{first.watchLabel}</div>}
            </dd>
            {payment.toMuxedId && (
              <>
                <dt>Muxed ID</dt>
                <dd>{payment.toMuxedId}</dd>
              </>
            )}
            <dt>From</dt>
            <dd>
              {payment.from} <CopyButton value={payment.from} label="Copy sender address" />
              <ExplorerLink address={payment.from} />
            </dd>
            <dt>Amount</dt>
            <dd>
              <Amount amount={payment.amount} code={payment.asset.code} />
            </dd>
            <dt>Amount (stroops)</dt>
            <dd>{payment.amountStroops}</dd>
            <dt>Asset</dt>
            <dd>
              {payment.asset.code}
              <div className="wh-reason" style={{ overflowWrap: "anywhere" }}>
                {payment.asset.issuer ? `issuer ${payment.asset.issuer}` : "native"}
              </div>
            </dd>
            <dt>Memo</dt>
            <dd>{payment.memo ?? <span className="muted">—</span>}</dd>
            <dt>Memo type</dt>
            <dd>{payment.memoType}</dd>
            <dt>Transaction</dt>
            <dd>
              <a className="wh-hash" href={tx} target="_blank" rel="noopener">
                {payment.txHash.slice(0, 8)}…{payment.txHash.slice(-8)}
                <Icon name="external-link" size={14} />
              </a>{" "}
              <CopyButton value={payment.txHash} label="Copy transaction hash" />
            </dd>
            <dt>Ledger</dt>
            <dd>
              <a
                className="wh-hash"
                href={explorer.ledger(payment.ledger)}
                target="_blank"
                rel="noopener"
              >
                {payment.ledger}
                <Icon name="external-link" size={14} />
              </a>
            </dd>
            <dt>Ledger closed</dt>
            <dd>{utc(payment.ledgerClosedAt)}</dd>
            {payment.matches.map((match) => (
              <div key={match.watchId} style={{ display: "contents" }}>
                <dt>Watch</dt>
                <dd>
                  <Link href={`/watches/view?id=${match.watchId}`}>
                    {match.watchLabel ?? "Untitled watch"}
                  </Link>{" "}
                  <span className="wh-reason">{match.watchId}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="stack">
          {payment.matches.map((match) => (
            <MatchPanels
              key={match.watchId}
              payment={payment}
              match={match}
              watch={watchFor(match)}
              endpoints={endpoints.data?.data ?? []}
            />
          ))}
        </div>
      </div>
    </>
  );
}

export default function PaymentViewPage() {
  return <WithId>{(id) => <PaymentView id={id} />}</WithId>;
}
