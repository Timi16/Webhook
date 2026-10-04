"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { JsonBlock, SetupFrame } from "@/components/setup";
import { ErrorAlert } from "@/components/ui";
import { api } from "@/lib/api";
import { duration } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import { useSetup, type Setup } from "@/lib/setup";
import type { Endpoint, EventDetail } from "@/lib/types";

interface TestResponse {
  eventId: string;
  attempt: { statusCode: number | null; durationMs: number; error: string | null } | null;
}

const delivered = (result: TestResponse | undefined) =>
  result?.attempt?.statusCode != null && result.attempt.statusCode >= 200 && result.attempt.statusCode < 300;

function TestStep({ setup, endpoint }: { setup: Setup; endpoint: Endpoint }) {
  const [result, setResult] = useState<TestResponse>();
  const send = useAction(async () => {
    setResult(undefined);
    const response = await api<TestResponse>(`/v1/endpoints/${endpoint.id}/test`, { method: "POST" });
    setResult(response);
    if (delivered(response) && response.attempt?.statusCode != null) {
      setup.saveDraft({ test: { endpointId: endpoint.id, eventId: response.eventId, statusCode: response.attempt.statusCode, durationMs: response.attempt.durationMs } });
    }
  });
  // The event holds exactly what was sent and what the server answered.
  const event = useApi<{ event: EventDetail }>(result ? `/v1/events/${result.eventId}` : null).data?.event;
  const snippet = event?.deliveries[0]?.attempts[0]?.responseSnippet;
  const ok = delivered(result) || (!result && setup.test !== undefined);
  const shown = result?.attempt ?? (setup.test && !result ? { statusCode: setup.test.statusCode, durationMs: setup.test.durationMs, error: null } : undefined);
  const eventId = result?.eventId ?? setup.test?.eventId;
  const status = shown?.statusCode;
  const sample = {
    id: "evt_…",
    type: "test.ping",
    apiVersion: "2026-10-01",
    createdAt: "…",
    data: { endpointId: endpoint.id, message: "Test webhook from Webhook" },
  };

  return (
    <div className="wz-grid">
      <div className="wz-main">
        <span className="wz-eyebrow">Step 3 · Test</span>
        <h1>Send a test webhook</h1>
        <p className="lede">
          We'll send a signed{" "}
          <span className="mono" style={{ color: "var(--ink)" }}>
            test.ping
          </span>{" "}
          to your endpoint. Your code should verify the signature and answer 2xx within 10 seconds.
        </p>
        <section className="wh-panel">
          <header>
            <span className="h">The request</span>
            <span className="code-chip">test.ping</span>
          </header>
          <div className="panel-body">
            <div className="wz-req">
              <div className="line">
                <span className="verb">POST</span>
                <span style={{ overflowWrap: "anywhere" }}>{endpoint.url}</span>
              </div>
              <div className="line h">Content-Type: application/json</div>
              <div className="line h">Webhook-Id: {eventId ?? "evt_…"}</div>
              <div className="line h">Webhook-Timestamp: unix seconds</div>
              <div className="line h">Webhook-Signature: v1=hex HMAC-SHA256 of timestamp.body</div>
            </div>
            <JsonBlock value={event?.payload ?? sample} label="Test payload" />
            <div className="wz-inline" role={send.pending ? "status" : undefined}>
              <button className="wh-btn is-primary" type="button" aria-busy={send.pending} disabled={send.pending || endpoint.status === "DISABLED"} onClick={() => void send.run()}>
                {send.pending ? <span className="wz-spin" aria-hidden="true" /> : <Icon name={shown ? "rotate" : "send"} />}
                {send.pending ? "Sending…" : shown ? "Send again" : "Send test webhook"}
              </button>
              <span className="hint">{send.pending ? "Waiting for your server to answer." : "Nothing changes in your account. It's just a ping."}</span>
            </div>
            {endpoint.status === "DISABLED" && (
              <div className="wh-help is-warn">
                <Icon name="alert-triangle" />
                <span>
                  This endpoint is disabled. <Link href="/endpoints">Re-enable it</Link> to send a test.
                </span>
              </div>
            )}
            {send.error && <ErrorAlert error={send.error} title="The test couldn't be sent." />}
          </div>
        </section>

        {shown && ok && (
          <section className="wh-panel wz-print" role="status">
            <header>
              <span className="h">Response</span>
              <span className="wh-badge is-ok">
                <Icon name="check-check" size={14} className="ic-b" />
                delivered
              </span>
            </header>
            <div className="panel-body">
              <div className="result">
                <span className="wh-badge is-ok">{status}</span>
                <span>
                  <strong style={{ color: "var(--ink)" }}>{duration(shown.durationMs)}</strong> round trip
                </span>
                <span>attempt 1</span>
                <span>{eventId}</span>
              </div>
              {snippet && (
                <pre className="wz-code" style={{ background: "var(--paper)", color: "var(--ink)", border: "2px solid var(--rule)" }}>
                  {snippet}
                </pre>
              )}
              <p className="hint" style={{ color: "var(--ok)", fontWeight: 600 }}>
                Your endpoint answered 2xx in time. Make sure it checked the signature first, then you're ready for a real payment.
              </p>
            </div>
          </section>
        )}
        {shown && !ok && (
          <section className="wh-panel wz-print" role="alert" style={{ borderColor: "var(--bad)", boxShadow: "5px 5px 0 var(--bad)" }}>
            <header>
              <span className="h">Response</span>
              <span className="wh-badge is-bad">
                <Icon name="alert-circle" size={14} className="ic-b" />
                failed
              </span>
            </header>
            <div className="panel-body">
              <div className="result">
                <span className="wh-badge is-bad">{status ?? "no response"}</span>
                <span>
                  <strong style={{ color: "var(--ink)" }}>{duration(shown.durationMs)}</strong> round trip
                </span>
                <span>attempt 1</span>
                <span>{eventId}</span>
              </div>
              {(snippet ?? shown.error) && (
                <pre className="wz-code" style={{ background: "var(--paper)", color: "var(--ink)", border: "2px solid var(--rule)" }}>
                  {snippet ?? shown.error}
                </pre>
              )}
              {status === 400 || status === 401 || status === 403 ? (
                <>
                  <p style={{ margin: 0, fontWeight: 600 }}>Your server rejected the request. If it's the signature check, the usual causes:</p>
                  <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
                    <li>
                      The body was parsed as JSON before you hashed it. Hash the <span className="mono">raw</span> bytes.
                    </li>
                    <li>
                      The secret in <span className="mono">WEBHOOK_SECRET</span> isn't the one from step 2.
                    </li>
                    <li>
                      You hashed only the body. Sign <span className="mono">timestamp + "." + body</span>.
                    </li>
                  </ol>
                </>
              ) : status == null ? (
                <p style={{ margin: 0, fontWeight: 600 }}>We couldn't get an answer. Check the URL is public, the server is running, and it responds within 10 seconds.</p>
              ) : (
                <p style={{ margin: 0, fontWeight: 600 }}>Your server answered {status}. Return any 2xx once the signature checks out.</p>
              )}
              <p className="hint">This test keeps retrying in the background like a real webhook. You can follow it in Webhook events.</p>
            </div>
          </section>
        )}
        {result && !result.attempt && (
          <div className="wh-alert is-warn" role="status">
            <Icon name="clock" />
            <div className="body">
              <strong>Still queued.</strong> The test wasn't sent within 12 seconds. It stays in the queue; check <Link href={`/events/view?id=${result.eventId}`}>its event</Link> in a moment.
            </div>
          </div>
        )}

        <div className="wz-actions">
          <Link className="wh-btn is-ghost" href="/onboarding/endpoint">
            <Icon name="arrow-left" />
            Back
          </Link>
          <div className="r">
            {!ok && (
              <Link className="wh-btn is-ghost" href="/onboarding/payment">
                Skip this step
              </Link>
            )}
            {ok && (
              <Link className="wh-btn is-primary" href="/onboarding/payment">
                Continue
                <Icon name="arrow-right" />
              </Link>
            )}
          </div>
        </div>
      </div>
      <aside className="wz-side">
        <div className="wz-card">
          <h3>
            <Icon name="list-checks" size={18} />
            What a good answer looks like
          </h3>
          <ol>
            <li>
              Verify <span className="mono">Webhook-Signature</span> with your secret.
            </li>
            <li>
              Return any <b>2xx</b> within <b>10 seconds</b>.
            </li>
            <li>Do slow work after you respond, in a queue.</li>
          </ol>
          <p>Anything else counts as a failure, and we retry with backoff: 10 attempts over about two days.</p>
        </div>
      </aside>
    </div>
  );
}

export default function TestStepPage() {
  const setup = useSetup();
  return (
    <SetupFrame setup={setup} step="test">
      {setup.endpoint ? (
        <TestStep setup={setup} endpoint={setup.endpoint} />
      ) : (
        <div className="wh-alert is-warn" role="status">
          <Icon name="alert-triangle" />
          <div className="body">
            <strong>No endpoint yet.</strong> Set one up first, then send it a test.
          </div>
          <Link className="wh-btn is-sm" href="/onboarding/endpoint">
            Set your endpoint
          </Link>
        </div>
      )}
    </SetupFrame>
  );
}
