"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { WithId } from "@/components/query";
import { CurlButton } from "@/components/curl";
import { Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { clockTime, relativeTime, shortUrl } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { Endpoint, EventDetail } from "@/lib/types";

const MAX_ATTEMPTS = 10;
type Attempt = EventDetail["deliveries"][number]["attempts"][number];

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
const withMs = (iso: string) => `${clockTime(iso)}.${iso.slice(20, 23)}`;

const ERROR_TEXT: Record<string, string> = {
  TIMEOUT: "No response within 10 s",
  DNS: "The hostname did not resolve",
  CONN_REFUSED: "The connection could not be made or was dropped",
  TLS: "The TLS handshake failed or the certificate is invalid",
  REDIRECT: "The server answered with a redirect, which we don't follow",
  SSRF_BLOCKED: "The hostname resolved to a private or internal address",
  BODY_TOO_LARGE: "The response was over 64 KB; only the status counted",
  INTERNAL: "We couldn't send this attempt",
};

function attemptView(attempt: Attempt): {
  tone: "ok" | "bad" | "warn";
  icon: IconName;
  label: string;
  note: string | null;
} {
  const ok = attempt.statusCode !== null && attempt.statusCode >= 200 && attempt.statusCode < 300;
  if (ok)
    return {
      tone: "ok",
      icon: "check",
      label: String(attempt.statusCode),
      note: attempt.error ? (ERROR_TEXT[attempt.error] ?? attempt.error) : null,
    };
  if (attempt.error === "TIMEOUT")
    return { tone: "warn", icon: "timer", label: "timeout", note: ERROR_TEXT.TIMEOUT ?? null };
  const label =
    attempt.statusCode !== null
      ? String(attempt.statusCode)
      : (attempt.error ?? "error").toLowerCase();
  const note = attempt.error
    ? (ERROR_TEXT[attempt.error] ?? attempt.error)
    : `Server returned ${attempt.statusCode}`;
  return { tone: "bad", icon: "x", label, note };
}

/** One line of pretty-printed JSON, with its key and punctuation coloured as in the design. */
function JsonLine({ line }: { line: string }) {
  const match = /^(\s*)("(?:[^"\\]|\\.)*")(:)(.*)$/.exec(line);
  if (!match) return <span className="l">{line}</span>;
  return (
    <span className="l">
      {match[1]}
      <span className="k">{match[2]}</span>
      <span className="p">{match[3]}</span>
      {match[4]}
    </span>
  );
}

function EventView({ id }: { id: string }) {
  const detail = useApi<{ event: EventDetail }>(`/v1/events/${encodeURIComponent(id)}`, [
    "delivery.updated",
  ]);
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [queued, setQueued] = useState(false);
  const resend = useAction(async () => {
    await api(`/v1/events/${encodeURIComponent(id)}/resend`, { method: "POST" });
    setQueued(true);
    detail.reload();
  });
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const event = detail.data?.event;
  if (detail.error && !event) {
    return detail.error.status === 404 ? (
      <Empty
        icon="search"
        title="Event not found"
        actions={
          <Link className="wh-btn" href="/events">
            Back to webhook events
          </Link>
        }
      >
        The link may be wrong, or the event belongs to another account.
      </Empty>
    ) : (
      <ErrorAlert error={detail.error} title="Couldn't load this event." onRetry={detail.reload} />
    );
  }
  if (!event) return <div aria-busy="true" />;

  const delivery = event.deliveries[0];
  const endpoint = endpoints.data?.data.find((e) => e.id === delivery?.endpointId);
  const json = JSON.stringify(event.payload, null, 2);
  const payment = (
    event.payload as {
      data?: {
        payment?: { amount?: string; asset?: { code?: string } };
        watch?: { label?: string | null };
      };
    }
  ).data;
  const summary = payment?.payment?.amount
    ? ` · ${payment.payment.amount} ${payment.payment.asset?.code ?? ""}${payment.watch?.label ? ` to ${payment.watch.label}` : ""}`
    : "";
  const left = delivery ? Math.max(0, MAX_ATTEMPTS - delivery.attemptCount) : 0;

  return (
    <>
      <PageHead
        back={{ href: "/events", label: "Webhook events" }}
        title={<span className="mono">{event.id}</span>}
        sub={`${event.type}${summary}`}
        actions={
          <>
            {delivery && <StatusBadge status={delivery.status} />}
            <CurlButton path={`/v1/events/${event.id}`} />
            <button
              className="wh-btn"
              type="button"
              disabled={resend.pending || delivery?.status === "CANCELLED"}
              onClick={() => void resend.run()}
            >
              <Icon name="send" />
              {resend.pending ? "Queuing…" : "Resend now"}
            </button>
          </>
        }
      />
      {queued && !resend.error && (
        <div className="wh-alert is-neutral" role="status">
          <Icon name="send" />
          <div className="body">
            <strong>Queued a new attempt.</strong> It replaces any scheduled retry and keeps the
            same event ID. Results show in the timeline.
          </div>
        </div>
      )}
      {resend.error && (
        <ErrorAlert
          error={resend.error}
          title={
            resend.error.code === "CONFLICT"
              ? "This event can't be resent right now."
              : "Couldn't resend this event."
          }
        />
      )}
      <dl className="wh-dl">
        <dt>Event</dt>
        <dd>{event.id}</dd>
        <dt>Type</dt>
        <dd>
          <span className="code-chip">{event.type}</span>
        </dd>
        <dt>Created</dt>
        <dd>{utc(event.createdAt)}</dd>
        <dt>Endpoint</dt>
        <dd>
          {endpoint ? (
            <Link href="/endpoints">{shortUrl(endpoint.url)}</Link>
          ) : (
            <span className="muted">deleted endpoint</span>
          )}
        </dd>
        {event.paymentId && (
          <>
            <dt>Payment</dt>
            <dd>
              <Link href={`/payments/view?id=${encodeURIComponent(event.paymentId)}`}>
                {event.paymentId}
              </Link>
            </dd>
          </>
        )}
        <dt>Signature</dt>
        <dd>Webhook-Signature: v1=hex(HMAC-SHA256(secret, timestamp + "." + body))</dd>
      </dl>
      <div className="cols-wide">
        <section className="wh-panel">
          <header>
            <span className="mono" style={{ fontSize: 13 }}>
              payload.json
            </span>
            <span className="wh-row">
              <button
                className="wh-btn is-sm is-ghost"
                type="button"
                aria-pressed={wrap}
                onClick={() => setWrap(!wrap)}
              >
                <Icon name="wrap-text" size={14} />
                Wrap
              </button>
              <button
                className="wh-copy"
                type="button"
                aria-label="Copy JSON payload"
                onClick={() => {
                  void navigator.clipboard.writeText(json).then(() => setCopied(true));
                }}
              >
                <Icon name={copied ? "check" : "copy"} size={14} />
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </span>
          </header>
          <pre
            className={wrap ? "wh-json is-wrap" : "wh-json"}
            tabIndex={0}
            aria-label="Webhook payload"
          >
            {json.split("\n").map((line, index) => (
              <JsonLine key={index} line={line} />
            ))}
          </pre>
        </section>
        <section className="wh-panel">
          <header>
            <span className="h">Delivery attempts</span>
            <span className="wh-reason">
              backoff 30s · 2m · 10m · 30m · 1h · 3h · 6h · 12h · 24h
            </span>
          </header>
          {!delivery || (delivery.attempts.length === 0 && delivery.status !== "RETRYING") ? (
            <p className="panel-empty">
              {delivery?.status === "CANCELLED"
                ? "Cancelled before it was sent: its endpoint was deleted."
                : "No attempt yet. The first one is sent within a second or two."}
            </p>
          ) : (
            <ol className="wh-tl">
              {delivery.attempts.map((attempt) => {
                const view = attemptView(attempt);
                return (
                  <li key={attempt.number}>
                    <span className={`node is-${view.tone}`}>
                      <Icon name={view.icon} size={14} className="ic-b" />
                    </span>
                    <div>
                      <div className="meta">
                        <strong>#{attempt.number}</strong>
                        <span>{withMs(attempt.startedAt)}</span>
                        <span className={`wh-badge is-${view.tone}`}>{view.label}</span>
                        <span>{attempt.durationMs.toLocaleString("en-US")} ms</span>
                      </div>
                      {view.note && <div className="err">{view.note}</div>}
                      {attempt.responseSnippet && (
                        <details>
                          <summary>Response · first 1 KB</summary>
                          {/* Text from the developer's own server: always rendered as plain text. */}
                          <pre>{attempt.responseSnippet}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
              {delivery.status === "RETRYING" && delivery.nextAttemptAt && (
                <li className="is-next">
                  <span className="node is-next">
                    <Icon name="clock" size={14} className="ic-b" />
                  </span>
                  <div>
                    <div className="meta">
                      <strong>#{delivery.attemptCount + 1}</strong>
                      <span>scheduled {clockTime(delivery.nextAttemptAt)}</span>
                      <span>
                        {relativeTime(delivery.nextAttemptAt)} · {left}{" "}
                        {left === 1 ? "attempt" : "attempts"} left
                      </span>
                    </div>
                  </div>
                </li>
              )}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

export default function EventViewPage() {
  return <WithId>{(id) => <EventView id={id} />}</WithId>;
}
