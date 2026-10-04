"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import { SecretModal } from "@/components/secret";
import { CopyButton, Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { clockTime, dateTime, duration, shortUrl } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { Endpoint, EndpointDetail } from "@/lib/types";

// Local development delivers to a receiver on this machine; the API decides whether that is allowed.
const ALLOW_LOCAL = process.env.NEXT_PUBLIC_ALLOW_INSECURE_TARGETS === "true";

interface TestResult {
  eventId: string;
  attempt: { statusCode: number | null; durationMs: number; error: string | null } | null;
}

type UrlState = "empty" | "ok" | "http" | "local" | "dup" | "bad";

function urlState(raw: string, existing: Endpoint[]): UrlState {
  const url = raw.trim();
  if (!url) return "empty";
  if (ALLOW_LOCAL && /^https?:\/\/[^\s/]+/i.test(url))
    return existing.some((e) => shortUrl(e.url) === shortUrl(url)) ? "dup" : "ok";
  if (/^http:\/\//i.test(url)) return "http";
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(url)) return "local";
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(url)) return "bad";
  return existing.some((e) => shortUrl(e.url) === shortUrl(url)) ? "dup" : "ok";
}

function AddEndpoint({
  existing,
  onClose,
  onCreated,
}: {
  existing: Endpoint[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [rejected_, setRejected] = useState(true);
  const [created, setCreated] = useState<{ endpoint: Endpoint; secret: string }>();
  const state = urlState(url, existing);
  const save = useAction(async () => {
    const result = await api<{ endpoint: Endpoint; secret: string }>("/v1/endpoints", {
      method: "POST",
      body: {
        url: url.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        eventTypes: rejected_ ? ["payment.received", "payment.rejected"] : ["payment.received"],
      },
    });
    setCreated(result);
    onCreated();
  });

  if (created) {
    return (
      <SecretModal
        title="Endpoint saved. Here's its signing secret."
        label={
          <>
            Signing secret for <span className="mono">{shortUrl(created.endpoint.url)}</span>
          </>
        }
        secret={created.secret}
        onDone={onClose}
      >
        Store it as{" "}
        <span className="mono" style={{ color: "var(--ink)" }}>
          WEBHOOK_SECRET
        </span>{" "}
        on the server behind this URL, and verify the{" "}
        <span className="mono" style={{ color: "var(--ink)" }}>
          Webhook-Signature
        </span>{" "}
        header on every request. After this, the only option is to rotate it.
      </SecretModal>
    );
  }

  const rejected =
    save.error && ["INSECURE_URL", "SSRF_BLOCKED", "VALIDATION_FAILED"].includes(save.error.code);
  return (
    <Modal
      title="Add an endpoint"
      onClose={onClose}
      footer={
        <>
          <button className="wh-btn is-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="wh-btn is-primary"
            type="button"
            disabled={state !== "ok" || save.pending}
            onClick={() => void save.run()}
          >
            <Icon name="save" />
            {save.pending ? "Saving…" : "Save endpoint"}
          </button>
        </>
      }
    >
      <div className="wh-field">
        <label htmlFor="ep-url">Endpoint URL</label>
        <input
          id="ep-url"
          className="wh-input mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={["http", "dup", "bad"].includes(state) || rejected ? true : undefined}
          aria-describedby="ep-url-help"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.yourapp.com/hooks/stellar"
        />
        <div id="ep-url-help" aria-live="polite">
          {state === "empty" && (
            <div className="wh-help">A public https URL. We POST signed JSON to it.</div>
          )}
          {state === "ok" && !rejected && (
            <div className="wh-help is-ok">
              <Icon name="check-circle" />
              Looks good. Send a test after saving to confirm it's reachable.
            </div>
          )}
          {state === "http" && (
            <div className="wh-help is-bad">
              <Icon name="unlock" />
              <span>
                Use https://. Webhooks carry payment data, so we never send them over plain HTTP.
              </span>
            </div>
          )}
          {state === "local" && (
            <div className="wh-help is-warn">
              <Icon name="laptop" />
              <span>
                We can't reach localhost. Run{" "}
                <span className="mono" style={{ color: "var(--ink)" }}>
                  ngrok http 3000
                </span>{" "}
                and paste its https URL.
              </span>
            </div>
          )}
          {state === "dup" && (
            <div className="wh-help is-bad">
              <Icon name="copy" />
              <span>You already have this endpoint. Each URL can be added once.</span>
            </div>
          )}
          {state === "bad" && (
            <div className="wh-help is-bad">
              <Icon name="alert-circle" />
              <span>That doesn't look like a URL. Start with https:// and include the path.</span>
            </div>
          )}
        </div>
      </div>
      <div className="wh-field">
        <label htmlFor="ep-desc">
          Description{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            (optional)
          </span>
        </label>
        <input
          id="ep-desc"
          className="wh-input"
          maxLength={200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Production orders service"
        />
      </div>
      <div className="wh-field">
        <span style={{ font: "600 13px/16px var(--font-sans)" }}>Events to send</span>
        <div className="wz-checks">
          <label className="wz-check">
            <input type="checkbox" checked disabled />
            <span>
              <b>payment.received</b>
              <span>A payment matched your rules.</span>
            </span>
          </label>
          <label className="wz-check">
            <input
              type="checkbox"
              checked={rejected_}
              onChange={(e) => setRejected(e.target.checked)}
            />
            <span>
              <b>payment.rejected</b>
              <span>A payment arrived but missed a rule. The watch must ask for it too.</span>
            </span>
          </label>
        </div>
      </div>
      {save.error && (
        <div className="wh-help is-bad" role="alert">
          <Icon name="alert-circle" />
          <span>{save.error.message}</span>
        </div>
      )}
    </Modal>
  );
}

function EndpointCard({ endpoint, onChanged }: { endpoint: Endpoint; onChanged: () => void }) {
  const detail = useApi<{ endpoint: EndpointDetail }>(`/v1/endpoints/${endpoint.id}`, [
    "delivery.updated",
    "endpoint.updated",
  ]);
  const stats = detail.data?.endpoint.stats;
  const [result, setResult] = useState<TestResult>();
  const [dialog, setDialog] = useState<"rotate" | "delete">();
  const [secret, setSecret] = useState<{
    secret: string;
    previousSecretValidUntil: string | null;
  }>();

  const test = useAction(async () =>
    setResult(await api<TestResult>(`/v1/endpoints/${endpoint.id}/test`, { method: "POST" })),
  );
  const enable = useAction(async () => {
    await api(`/v1/endpoints/${endpoint.id}/enable`, { method: "POST" });
    onChanged();
  });
  const replay = useAction(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { requeued } = await api<{ requeued: number }>(`/v1/endpoints/${endpoint.id}/replay`, {
      method: "POST",
      body: { since },
    });
    detail.reload();
    return requeued;
  });
  const [replayed, setReplayed] = useState<number>();
  const rotate = useAction(async () => {
    setSecret(
      await api<{ secret: string; previousSecretValidUntil: string | null }>(
        `/v1/endpoints/${endpoint.id}/rotate-secret`,
        { method: "POST" },
      ),
    );
    setDialog(undefined);
    onChanged();
  });
  const sendsRejected = endpoint.eventTypes.includes("payment.rejected");
  const setEvents = useAction(async (withRejected: boolean) => {
    await api(`/v1/endpoints/${endpoint.id}`, {
      method: "PATCH",
      body: {
        eventTypes: withRejected ? ["payment.received", "payment.rejected"] : ["payment.received"],
      },
    });
    onChanged();
  });
  const remove = useAction(async () => {
    await api(`/v1/endpoints/${endpoint.id}`, { method: "DELETE" });
    setDialog(undefined);
    onChanged();
  });

  const last = stats?.lastAttempt;
  const lastProblem =
    last &&
    (last.error ??
      (last.statusCode !== null && (last.statusCode < 200 || last.statusCode > 299)
        ? String(last.statusCode)
        : null));
  const attempt = result?.attempt;
  const attemptOk =
    attempt?.statusCode != null && attempt.statusCode >= 200 && attempt.statusCode < 300;
  const error = test.error ?? enable.error ?? replay.error ?? setEvents.error;

  return (
    <section className="wh-panel">
      <header>
        <span className="h url" style={{ fontSize: 14 }}>
          {endpoint.url}
        </span>
        <StatusBadge status={endpoint.status} />
      </header>
      <div className="panel-body">
        <dl className="wh-dl is-plain" style={{ gridTemplateColumns: "180px minmax(0, 1fr)" }}>
          <dt>Endpoint ID</dt>
          <dd>
            {endpoint.id} <CopyButton value={endpoint.id} label="Copy endpoint ID" />
          </dd>
          {endpoint.description && (
            <>
              <dt>Description</dt>
              <dd style={{ fontFamily: "var(--font-sans)" }}>{endpoint.description}</dd>
            </>
          )}
          <dt>Events to send</dt>
          <dd className="wh-row" style={{ fontFamily: "var(--font-sans)", flexWrap: "wrap" }}>
            <span className="scope-chip">payment.received</span>
            <label className="wh-check" style={{ whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={sendsRejected}
                disabled={setEvents.pending}
                onChange={(e) => void setEvents.run(e.target.checked)}
              />
              <span className="mono">payment.rejected</span>
            </label>
          </dd>
          <dt>Failed events in a row</dt>
          <dd>{endpoint.consecutiveFailures}</dd>
          <dt>Last 24 hours</dt>
          <dd>
            {stats
              ? `${stats.last24h.delivered} delivered · ${stats.last24h.retrying} retrying · ${stats.last24h.failed} failed · ${stats.last24h.pending} waiting`
              : "…"}
          </dd>
          <dt>Signing secret</dt>
          <dd>
            {endpoint.previousSecretValidUntil
              ? `rotated · previous secret valid until ${dateTime(endpoint.previousSecretValidUntil)}`
              : "hidden · shown once when created or rotated"}
          </dd>
          <dt>Created</dt>
          <dd>{dateTime(endpoint.createdAt)}</dd>
        </dl>
        {endpoint.status === "FAILING" && (
          <div className="wh-alert is-warn">
            <Icon name="alert-triangle" />
            <div className="body">
              <strong>Recent deliveries are failing.</strong>
              {lastProblem && last && (
                <>
                  {" "}
                  Last error: <span className="mono">{lastProblem}</span> at {clockTime(last.at)}.
                </>
              )}{" "}
              We keep retrying with backoff for about two days; after 20 events in a row fail every
              attempt, we disable the endpoint.
            </div>
          </div>
        )}
        {endpoint.status === "DISABLED" && (
          <div className="wh-alert is-bad">
            <Icon name="ban" />
            <div className="body">
              <strong>
                {endpoint.disabledReason === "GONE"
                  ? "Disabled because it answered 410 Gone."
                  : "Disabled after 20 failed events in a row."}
              </strong>{" "}
              Nothing is being sent to it
              {stats && stats.last24h.pending + stats.last24h.retrying > 0
                ? `; ${stats.last24h.pending + stats.last24h.retrying} deliveries are waiting`
                : ""}
              . Re-enable it, then replay the failed ones.
            </div>
            <button
              className="wh-btn is-sm"
              type="button"
              disabled={enable.pending}
              onClick={() => void enable.run()}
            >
              Re-enable
            </button>
          </div>
        )}
        {error && <ErrorAlert error={error} title="That didn't work." />}
        {replayed !== undefined && (
          <div className="result" role="status">
            <span className="wh-badge is-ok">
              <Icon name="rotate" size={14} className="ic-b" />
              queued
            </span>
            <span>
              {replayed === 0
                ? "No failed deliveries in the last 7 days."
                : `${replayed} failed ${replayed === 1 ? "delivery" : "deliveries"} queued again.`}
            </span>
          </div>
        )}
        {result && (
          <div className="result" role="status">
            {attempt ? (
              <>
                <StatusBadge status={attemptOk ? "DELIVERED" : "FAILED"} />
                <span>
                  <strong style={{ color: "var(--ink)" }}>
                    {attempt.statusCode ?? attempt.error ?? "No response"}
                  </strong>{" "}
                  in {duration(attempt.durationMs)}
                </span>
              </>
            ) : (
              <>
                <StatusBadge status="PENDING" />
                <span>Queued. No attempt yet; check Webhook events in a moment.</span>
              </>
            )}
            <span>{result.eventId}</span>
          </div>
        )}
      </div>
      <div className="panel-foot">
        <button className="wh-btn is-sm is-ghost" type="button" onClick={() => setDialog("delete")}>
          <Icon name="trash" size={14} />
          Delete
        </button>
        <button className="wh-btn is-sm is-ghost" type="button" onClick={() => setDialog("rotate")}>
          <Icon name="rotate" size={14} />
          Rotate secret
        </button>
        {stats && stats.last24h.failed > 0 && endpoint.status !== "DISABLED" && (
          <button
            className="wh-btn is-sm is-ghost"
            type="button"
            disabled={replay.pending}
            onClick={() => void replay.run().then(setReplayed)}
          >
            <Icon name="rotate" size={14} />
            Replay failed
          </button>
        )}
        <button
          className="wh-btn is-sm"
          type="button"
          disabled={test.pending || endpoint.status === "DISABLED"}
          onClick={() => void test.run()}
        >
          <Icon name="send" size={14} />
          {test.pending ? "Sending…" : "Send test webhook"}
        </button>
      </div>

      {dialog === "rotate" && (
        <Modal
          title="Rotate signing secret?"
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <button
                className="wh-btn is-ghost"
                type="button"
                onClick={() => setDialog(undefined)}
              >
                Cancel
              </button>
              <button
                className="wh-btn is-primary"
                type="button"
                disabled={rotate.pending}
                onClick={() => void rotate.run()}
              >
                <Icon name="rotate" />
                Rotate secret
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            We'll create a new secret for <span className="mono">{shortUrl(endpoint.url)}</span> and
            show it once.
          </p>
          <dl className="wh-dl is-plain" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
            <dt>Now</dt>
            <dd style={{ fontFamily: "var(--font-sans)" }}>
              Webhooks are signed with both secrets. Your app can verify either.
            </dd>
            <dt>+24 hours</dt>
            <dd style={{ fontFamily: "var(--font-sans)" }}>
              The old secret stops working. Deploy the new one before then.
            </dd>
          </dl>
          {rotate.error && <ErrorAlert error={rotate.error} title="Couldn't rotate the secret." />}
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title="Delete this endpoint?"
          onClose={() => setDialog(undefined)}
          footer={
            <>
              <button
                className="wh-btn is-ghost"
                type="button"
                onClick={() => setDialog(undefined)}
              >
                Keep endpoint
              </button>
              <button
                className="wh-btn is-danger"
                type="button"
                disabled={remove.pending}
                onClick={() => void remove.run()}
              >
                <Icon name="trash" />
                Delete endpoint
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            <span className="mono">{shortUrl(endpoint.url)}</span> stops receiving webhooks and its
            unfinished deliveries are cancelled. Past events stay in your history. This can't be
            undone.
          </p>
          {remove.error && (
            <ErrorAlert
              error={remove.error}
              title={
                remove.error.code === "CONFLICT"
                  ? "An active watch still delivers here."
                  : "Couldn't delete this endpoint."
              }
            />
          )}
        </Modal>
      )}
      {secret && (
        <SecretModal
          title="Your new signing secret"
          label={
            <>
              Signing secret for <span className="mono">{shortUrl(endpoint.url)}</span>
            </>
          }
          secret={secret.secret}
          onDone={() => setSecret(undefined)}
        >
          Verify the{" "}
          <span className="mono" style={{ color: "var(--ink)" }}>
            Webhook-Signature
          </span>{" "}
          header with this secret on every request.
          {secret.previousSecretValidUntil && (
            <>
              {" "}
              Your previous secret keeps working until {dateTime(
                secret.previousSecretValidUntil,
              )}{" "}
              (24 hours), so you can deploy without dropping webhooks.
            </>
          )}
        </SecretModal>
      )}
    </section>
  );
}

export default function EndpointsPage() {
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints", ["endpoint.updated"]);
  const [adding, setAdding] = useState(false);
  const rows = endpoints.data?.data ?? [];
  const addButton = (
    <button className="wh-btn is-primary" type="button" onClick={() => setAdding(true)}>
      <Icon name="plus" />
      Add endpoint
    </button>
  );

  return (
    <>
      <PageHead
        title="Endpoints"
        sub="Where we send signed webhooks. We retry failures with backoff for about two days."
        actions={addButton}
      />
      {endpoints.error && !endpoints.data ? (
        <ErrorAlert
          error={endpoints.error}
          title="Couldn't load endpoints."
          onRetry={endpoints.reload}
        />
      ) : !endpoints.data ? (
        <div className="stack" aria-busy="true">
          <section className="wh-panel">
            <header>
              <span className="wh-skel" style={{ width: 260, height: 14 }} />
            </header>
            <div className="panel-body">
              <span className="wh-skel" style={{ width: "70%", height: 12 }} />
              <span className="wh-skel" style={{ width: "50%", height: 12 }} />
            </div>
          </section>
        </div>
      ) : rows.length === 0 ? (
        <Empty icon="webhook" title="Add your first endpoint" actions={addButton}>
          An endpoint is a URL on your server that receives signed webhooks. Add one, send it a
          test, then point a watch at it.
        </Empty>
      ) : (
        <div className="stack">
          {rows.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} onChanged={endpoints.reload} />
          ))}
        </div>
      )}
      {adding && (
        <AddEndpoint
          existing={rows}
          onClose={() => setAdding(false)}
          onCreated={endpoints.reload}
        />
      )}
    </>
  );
}
