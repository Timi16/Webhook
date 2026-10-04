"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { SetupFrame } from "@/components/setup";
import { api } from "@/lib/api";
import { clockTime, shortAddress, shortUrl } from "@/lib/format";
import { useApi, useLiveStatus } from "@/lib/hooks";
import { amountRuleLong, assetCodes, memoRuleLong } from "@/lib/rules";
import { useSetup, type Setup } from "@/lib/setup";
import type { PaymentDetail, Watch } from "@/lib/types";

const FRIENDBOT_URL = "https://lab.stellar.org/account/fund?$=network$id=testnet";

/** The receipt for the first payment: what was checked, and what was sent to the server. */
export function FirstPaymentReceipt({ payment, watch, endpointUrl }: { payment: PaymentDetail; watch: Watch; endpointUrl: string | undefined }) {
  const match = payment.matches.find((m) => m.watchId === watch.id) ?? payment.matches[0];
  if (!match) return null;
  const delivery = match.event?.deliveries[0];
  const verified = match.outcome === "VERIFIED";
  const checks = [
    ["ASSET", match.checks.asset],
    ["AMOUNT", match.checks.amount],
    ["MEMO", match.checks.memo],
    ["SENDER", match.checks.sender],
  ] as const;
  return (
    <div className="rcpt-wrap wz-print">
      <div className="rcpt" aria-label="Receipt for your first payment">
        <div className="c">
          <b>Your first payment</b>
          <br />
          {payment.id}
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
          <span>{clockTime(payment.ledgerClosedAt)}</span>
        </div>
        <div className="r">
          <span>FROM</span>
          <span>{shortAddress(payment.from)}</span>
        </div>
        <div className="r">
          <span>TO</span>
          <span>{watch.label ?? shortAddress(watch.walletAddress)}</span>
        </div>
        <hr />
        {checks.map(([name, check]) => (
          <div className="r" key={name}>
            <span>{name}</span>
            <span className={check.passed ? "pass" : "fail"}>{check.passed ? "PASS" : (check.reason ?? "FAIL")}</span>
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
        <div className="c">
          <span className="hl">{delivery ? `WEBHOOK ${delivery.status}` : "NO WEBHOOK SENT"}</span>
        </div>
        {match.event && endpointUrl && (
          <div className="c" style={{ marginTop: 8, fontSize: 11 }}>
            {match.event.type} → {shortUrl(endpointUrl)}
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentStep({ setup, watch }: { setup: Setup; watch: Watch }) {
  const live = useLiveStatus();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const [ledger, setLedger] = useState<number | null>(null);
  useEffect(() => {
    api<{ lastLedger: number | null }>("/health").then(
      (health) => setLedger(health.lastLedger),
      () => {},
    );
  }, []);
  const detail = useApi<{ payment: PaymentDetail }>(setup.payment ? `/v1/payments/${setup.payment.id}` : null, ["delivery.updated"]).data?.payment;
  const match = detail?.matches.find((m) => m.watchId === watch.id) ?? detail?.matches[0];
  const delivery = match?.event?.deliveries[0];
  const arrived = setup.payment !== undefined;
  const code = assetCodes(watch);
  const name = watch.label ?? shortAddress(watch.walletAddress);

  return (
    <div className="wz-grid">
      <div className="wz-main">
        <span className="wz-eyebrow">Step 4 · Payment</span>
        <h1>Now pay your wallet</h1>
        <p className="lede">
          Send testnet {code} to {name} from a different testnet account. We'll spot it on the ledger, check it against your rules and fire{" "}
          <span className="mono" style={{ color: "var(--ink)" }}>
            payment.received
          </span>
          .
        </p>
        <div className="wz-addr">
          <span className="k">Send to · {name}</span>
          <code>{watch.walletAddress}</code>
          <div className="row">
            <div className="facts">
              <span>Asset {code}</span>
              <span>{amountRuleLong(watch.amountRule, code)}</span>
              <span>{memoRuleLong(watch.memoRule)}</span>
            </div>
            <button className="wh-btn is-sm" type="button" aria-label="Copy wallet address" onClick={() => void navigator.clipboard.writeText(watch.walletAddress).then(() => setCopied(true))}>
              <Icon name={copied ? "check" : "copy"} size={14} />
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
        </div>
        <div className="wz-ways">
          <a className="wz-way" href="https://lab.stellar.org/transaction/build?$=network$id=testnet" target="_blank" rel="noopener">
            <b>
              <Icon name="flask" />
              Stellar Lab
            </b>
            <span>Build a Payment operation in the browser and sign it.</span>
          </a>
          <a className="wz-way" href="https://www.freighter.app" target="_blank" rel="noopener">
            <b>
              <Icon name="wallet" />
              Freighter wallet
            </b>
            <span>Switch it to Testnet, then send from your test account.</span>
          </a>
          <a className="wz-way" href="https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-payments" target="_blank" rel="noopener">
            <b>
              <Icon name="code" />
              From code
            </b>
            <span>Use the Stellar SDK with a funded testnet keypair.</span>
          </a>
        </div>
        {!arrived ? (
          <div className="wz-wait" role="status">
            <span className="wz-radar" aria-hidden="true">
              <Icon name="radio" size={20} />
            </span>
            <div>
              <b>Watching the ledger for your payment…</b>
              <span>
                {ledger !== null ? `Ledger ${ledger} · ` : ""}
                {live ? "live, this page updates by itself" : "reconnecting…"} · usually lands within 10 s of sending
              </span>
            </div>
          </div>
        ) : match?.outcome === "REJECTED" ? (
          <div className="wh-alert is-warn wz-print" role="status">
            <Icon name="alert-triangle" />
            <div className="body">
              <strong>A payment landed, but it missed your rules.</strong> {match.reasons.join(", ")}. {match.event ? "Your server was told with payment.rejected." : "No webhook is sent for rejected payments on this watch."}
            </div>
          </div>
        ) : delivery && delivery.status !== "DELIVERED" ? (
          <div className="wh-alert is-warn wz-print" role="status">
            <Icon name="rotate" />
            <div className="body">
              <strong>Payment verified. The webhook is {delivery.status.toLowerCase()}.</strong> Follow its attempts in <Link href={`/events/view?id=${match?.event?.id ?? ""}`}>Webhook events</Link>.
            </div>
          </div>
        ) : (
          <div className="wh-alert is-neutral wz-print" role="status" style={{ background: "var(--ok-soft, #D7F2E5)" }}>
            <Icon name="party" />
            <div className="body">
              <strong>Payment landed{delivery ? " and your server got the webhook" : ""}.</strong> That's the whole loop working end to end.
            </div>
          </div>
        )}
        <div className="wz-actions">
          <Link className="wh-btn is-ghost" href="/onboarding/test">
            <Icon name="arrow-left" />
            Back
          </Link>
          <div className="r">
            <Link className={arrived ? "wh-btn is-primary" : "wh-btn is-ghost"} href="/onboarding/done">
              {arrived ? "Finish setup" : "I'll do this later"}
              {arrived && <Icon name="arrow-right" />}
            </Link>
          </div>
        </div>
      </div>
      <aside className="wz-side">
        {detail ? (
          <FirstPaymentReceipt payment={detail} watch={watch} endpointUrl={setup.endpoint?.url} />
        ) : (
          <>
            <div className="wz-card">
              <h3>
                <Icon name="receipt" size={18} />
                Your receipt prints here
              </h3>
              <p>As soon as the payment closes on the ledger, you'll see what we checked and what we sent to your server.</p>
              <div className="wh-col" style={{ gap: 8 }}>
                {["70%", "90%", "55%", "80%"].map((width) => (
                  <span className="wh-skel" style={{ width }} key={width} />
                ))}
              </div>
            </div>
            <div className="wz-card is-yellow">
              <h3>
                <Icon name="droplets" size={18} />
                Need testnet funds?
              </h3>
              <p>Friendbot gives any new testnet account 10,000 XLM. For testnet USDC, add a trustline and swap some XLM for it.</p>
              <a className="wh-btn is-sm" href={FRIENDBOT_URL} target="_blank" rel="noopener">
                Fund with Friendbot
                <Icon name="external-link" size={14} />
              </a>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export default function PaymentStepPage() {
  const setup = useSetup();
  return (
    <SetupFrame setup={setup} step="payment">
      {setup.watch ? (
        <PaymentStep setup={setup} watch={setup.watch} />
      ) : (
        <div className="wh-alert is-warn" role="status">
          <Icon name="alert-triangle" />
          <div className="body">
            <strong>No wallet yet.</strong> Add the wallet to watch and an endpoint first.
          </div>
          <Link className="wh-btn is-sm" href="/onboarding/wallet">
            Add a wallet
          </Link>
        </div>
      )}
    </SetupFrame>
  );
}
