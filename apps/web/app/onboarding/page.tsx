"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { TestnetBanner } from "@/components/banner";
import { Icon, Logo } from "@/components/icons";
import { CopyButton, ErrorAlert } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, shortAddress, shortUrl } from "@/lib/format";
import { useAction, useLiveStatus } from "@/lib/hooks";
import { assetCodes } from "@/lib/rules";
import { useSetup } from "@/lib/setup";

interface TestResponse {
  eventId: string;
  attempt: { statusCode: number | null; durationMs: number; error: string | null } | null;
}

function Step({
  number,
  title,
  done,
  current,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <li className={current ? "step is-current" : "step"}>
      {done ? (
        <span className="num is-done">
          <Icon name="check" className="ic-b" />
        </span>
      ) : (
        <span className="num">{number}</span>
      )}
      <div className="body">
        <h2>
          {title}{" "}
          {done && (
            <span className="wh-badge is-ok">
              <Icon name="check" size={14} className="ic-b" />
              done
            </span>
          )}
        </h2>
        {children}
      </div>
    </li>
  );
}

export default function OnboardingPage() {
  const setup = useSetup();
  const live = useLiveStatus();
  const { watch, endpoint, test, payment, done, doneCount, draft } = setup;
  const order = ["wallet", "endpoint", "test", "payment"] as const;
  const current = order.find((key) => !done[key]);

  const sendTest = useAction(async () => {
    if (!endpoint) return;
    const result = await api<TestResponse>(`/v1/endpoints/${endpoint.id}/test`, { method: "POST" });
    const status = result.attempt?.statusCode;
    if (result.attempt && status != null && status >= 200 && status < 300) {
      setup.saveDraft({
        test: {
          endpointId: endpoint.id,
          eventId: result.eventId,
          statusCode: status,
          durationMs: result.attempt.durationMs,
        },
      });
    }
    return result;
  });
  const address = watch?.walletAddress ?? draft.wallet?.address;

  return (
    <>
      <TestnetBanner />
      <div className="onb">
        <div className="wh-col" style={{ gap: 12 }}>
          <span className="brand" style={{ padding: 0 }}>
            <Logo />
            <span className="wordmark">webhook</span>
            <span className="net">testnet</span>
          </span>
          <h1 className="display">Get your first webhook in 4 steps</h1>
          <p className="hint">
            About five minutes. Everything runs on Stellar Testnet, so no real money moves.
          </p>
          <div className="wh-row" style={{ justifyContent: "space-between" }}>
            <span className="fine">{setup.ready ? `${doneCount} of 4 done` : "Loading…"}</span>
            <Link href={doneCount === 4 ? "/onboarding/done" : "/overview"}>
              {doneCount === 4 ? "See your setup receipt" : "Skip to overview"}
            </Link>
          </div>
          <div className="progress" aria-hidden="true">
            {order.map((key) => (
              <span className={setup.ready && done[key] ? "on" : undefined} key={key} />
            ))}
          </div>
        </div>
        {setup.error && !setup.ready ? (
          <ErrorAlert
            error={setup.error}
            title="Couldn't load your setup."
            onRetry={setup.reload}
          />
        ) : !setup.ready ? (
          <div aria-busy="true" style={{ minHeight: 320 }} />
        ) : (
          <ol className="steps">
            <Step number={1} title="Add a wallet" done={done.wallet} current={current === "wallet"}>
              {done.wallet && address ? (
                <>
                  <p className="done-line">
                    {watch?.label ?? draft.wallet?.label ?? "Wallet"} · {shortAddress(address)}
                    {watch ? ` · ${assetCodes(watch)}` : " · saved, waiting for an endpoint"}
                  </p>
                  <div className="wh-row">
                    <Link className="wh-btn is-sm is-ghost" href="/onboarding/wallet">
                      {watch ? "Open step" : "Edit step"}
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="hint">
                    Paste the public address that receives payments and say which payments count.
                  </p>
                  <div className="wh-row">
                    <Link className="wh-btn is-primary" href="/onboarding/wallet">
                      <Icon name="wallet" />
                      Add a wallet
                    </Link>
                  </div>
                </>
              )}
            </Step>
            <Step
              number={2}
              title="Set your webhook endpoint"
              done={done.endpoint}
              current={current === "endpoint"}
            >
              {done.endpoint && endpoint ? (
                <>
                  <p className="done-line">{shortUrl(endpoint.url)} · signing secret issued</p>
                  <div className="wh-row">
                    <Link className="wh-btn is-sm is-ghost" href="/onboarding/endpoint">
                      Open step
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="hint">
                    A public HTTPS URL on your server. You get a signing secret to verify what we
                    send.
                  </p>
                  <div className="wh-row">
                    <Link
                      className={current === "endpoint" ? "wh-btn is-primary" : "wh-btn"}
                      href="/onboarding/endpoint"
                    >
                      <Icon name="webhook" />
                      Set your endpoint
                    </Link>
                  </div>
                </>
              )}
            </Step>
            <Step
              number={3}
              title="Send a test webhook"
              done={done.test}
              current={current === "test"}
            >
              {test ? (
                <div className="result" role="status">
                  <span className="wh-badge is-ok">
                    <Icon name="check-check" size={14} className="ic-b" />
                    delivered
                  </span>
                  <span>
                    <strong style={{ color: "var(--ink)" }}>{test.statusCode} OK</strong> in{" "}
                    {duration(test.durationMs)}
                  </span>
                  <span>{test.eventId}</span>
                </div>
              ) : (
                <>
                  <p className="hint">
                    We send a signed{" "}
                    <span className="mono" style={{ color: "var(--ink)" }}>
                      test.ping
                    </span>{" "}
                    to your endpoint. Check that your code verifies the signature and returns 2xx
                    within 10 seconds.
                  </p>
                  <div className="wh-row">
                    <button
                      className="wh-btn is-primary"
                      type="button"
                      disabled={!endpoint || sendTest.pending}
                      onClick={() => void sendTest.run()}
                    >
                      <Icon name="send" />
                      {sendTest.pending ? "Sending…" : "Send test webhook"}
                    </button>
                    <Link className="wh-btn is-ghost" href="/onboarding/test">
                      Open step
                    </Link>
                  </div>
                  {sendTest.error && (
                    <ErrorAlert error={sendTest.error} title="The test couldn't be sent." />
                  )}
                </>
              )}
            </Step>
            <Step
              number={4}
              title="Make a testnet payment"
              done={done.payment}
              current={current === "payment"}
            >
              {payment ? (
                <>
                  <p className="done-line">
                    {payment.amount} {payment.asset.code} from {shortAddress(payment.from)} · ledger{" "}
                    {payment.ledger}
                  </p>
                  <div className="wh-row">
                    <Link
                      className="wh-btn is-sm is-ghost"
                      href={`/payments/view?id=${payment.id}`}
                    >
                      View payment
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="hint">
                    Send a testnet payment to your watched wallet from another testnet account.
                    We'll verify it and fire{" "}
                    <span className="mono" style={{ color: "var(--ink)" }}>
                      payment.received
                    </span>
                    .
                  </p>
                  {watch && (
                    <>
                      <div className="wh-secret" style={{ maxWidth: "100%" }}>
                        <code>{watch.walletAddress}</code>
                        <CopyButton value={watch.walletAddress} label="Copy wallet address" />
                      </div>
                      <div className="wh-row" style={{ justifyContent: "space-between" }}>
                        <span className={live ? "wh-live" : "wh-live is-warn"} role="status">
                          <span className="dot" aria-hidden="true" />
                          {live ? "Waiting for a payment…" : "Reconnecting…"}
                        </span>
                        <Link href="/onboarding/payment">Open step</Link>
                      </div>
                    </>
                  )}
                </>
              )}
            </Step>
          </ol>
        )}
      </div>
    </>
  );
}
