"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { SetupFrame } from "@/components/setup";
import { ErrorAlert, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { DOCS_URL } from "@/lib/constants";
import { shortAddress } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useSetup, watchBody, type Setup } from "@/lib/setup";
import type { Endpoint, Watch } from "@/lib/types";

// Local development delivers to a receiver on this machine; the API decides whether that is allowed.
const ALLOW_LOCAL = process.env.NEXT_PUBLIC_ALLOW_INSECURE_TARGETS === "true";

function urlState(raw: string): "ok" | "http" | "local" | "bad" {
  const url = raw.trim();
  if (!url) return "bad";
  if (ALLOW_LOCAL && /^https?:\/\/[^\s/]+/i.test(url)) return "ok";
  if (/^http:\/\//i.test(url)) return "http";
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(url)) return "local";
  return /^https:\/\/[^\s/]+\.[^\s/]+/i.test(url) ? "ok" : "bad";
}

function Secret({ secret }: { secret: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="wh-secret">
      <code>{shown ? secret : `whsec_${"•".repeat(30)}`}</code>
      <button className="wh-copy" type="button" aria-label={shown ? "Hide secret" : "Show secret"} aria-pressed={shown} onClick={() => setShown(!shown)}>
        <Icon name={shown ? "eye-off" : "eye"} size={14} />
      </button>
      <button className="wh-copy" type="button" aria-label="Copy signing secret" onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}>
        <Icon name={copied ? "check" : "copy"} size={14} />
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function EndpointStep({ setup }: { setup: Setup }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const [notifyRejected, setNotifyRejected] = useState(true);
  const [created, setCreated] = useState<{ endpoint: Endpoint; secret: string }>();
  const [stored, setStored] = useState(false);
  const state = urlState(url);
  const endpoint = created?.endpoint ?? setup.endpoint;
  const wallet = setup.draft.wallet;

  const createWatch = useAction(async (endpointId: string) => {
    if (!wallet) return;
    await api<{ watch: Watch }>("/v1/watches", { method: "POST", body: watchBody(wallet, endpointId, notifyRejected) });
    setup.saveDraft({ wallet: undefined });
    setup.reload();
  });
  const save = useAction(async () => {
    const result = await api<{ endpoint: Endpoint; secret: string }>("/v1/endpoints", { method: "POST", body: { url: url.trim(), eventTypes: notifyRejected ? ["payment.received", "payment.rejected"] : ["payment.received"] } });
    setCreated(result);
    if (!setup.watch) await createWatch.run(result.endpoint.id);
    else setup.reload();
  });

  const watchMissing = endpoint !== undefined && !setup.watch && !save.pending && !createWatch.pending;
  const canContinue = setup.done.endpoint && (!created || stored);
  const note = !endpoint ? "Save the endpoint first" : watchMissing ? "Your watch isn't saved yet" : created && !stored ? "Confirm you stored the secret" : "Next: send a test";

  return (
    <div className="wz-grid">
      <div className="wz-main">
        <span className="wz-eyebrow">Step 2 · Endpoint</span>
        <h1>Where should we send webhooks?</h1>
        <p className="lede">A public HTTPS URL on your server. We POST a signed JSON event to it every time a payment to your wallet is verified or rejected.</p>

        {!endpoint ? (
          <section className="wh-panel">
            <header>
              <span className="h">Endpoint</span>
            </header>
            <div className="panel-body">
              <div className="wh-field">
                <label htmlFor="url">Endpoint URL</label>
                <input
                  id="url"
                  className="wh-input mono"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setTouched(true);
                  }}
                  aria-invalid={touched && state !== "ok"}
                  aria-describedby="url-help"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://api.yourapp.com/hooks/stellar"
                />
                <div id="url-help" aria-live="polite">
                  {!touched ? (
                    <div className="wh-help">Include the path, for example /hooks/stellar.</div>
                  ) : state === "ok" ? (
                    <div className="wh-help is-ok">
                      <Icon name="check-circle" />
                      Looks good. We'll check it's reachable when you send a test.
                    </div>
                  ) : state === "http" ? (
                    <div className="wh-help is-bad">
                      <Icon name="unlock" />
                      <span>Use https://. Webhooks carry payment data, so we never send them over plain HTTP.</span>
                    </div>
                  ) : state === "local" ? (
                    <div className="wh-help is-warn">
                      <Icon name="laptop" />
                      <span>
                        We can't reach localhost from the internet. Run{" "}
                        <span className="mono" style={{ color: "var(--ink)" }}>
                          ngrok http 3000
                        </span>{" "}
                        and paste the https URL it gives you.
                      </span>
                    </div>
                  ) : (
                    <div className="wh-help is-bad">
                      <Icon name="alert-circle" />
                      <span>That doesn't look like a URL. Start with https:// and include the path.</span>
                    </div>
                  )}
                </div>
              </div>
              {wallet && (
                <div className="wh-field">
                  <span style={{ font: "600 13px/16px var(--font-sans)" }}>Events to send</span>
                  <div className="wz-checks">
                    <label className="wz-check">
                      <input type="checkbox" checked disabled />
                      <span>
                        <b>payment.received</b>
                        <span>A payment matched your rules. Always sent.</span>
                      </span>
                    </label>
                    <label className="wz-check">
                      <input type="checkbox" checked={notifyRejected} onChange={(e) => setNotifyRejected(e.target.checked)} />
                      <span>
                        <b>payment.rejected</b>
                        <span>A payment arrived but missed a rule. Includes the reason code.</span>
                      </span>
                    </label>
                  </div>
                </div>
              )}
              <div className="wz-inline">
                <button className="wh-btn is-primary" type="button" disabled={state !== "ok" || save.pending} onClick={() => void save.run()}>
                  <Icon name="save" />
                  {save.pending ? "Saving…" : "Save endpoint"}
                </button>
                <span className="hint">You'll get a signing secret next. It's shown once.</span>
              </div>
              {save.error && <ErrorAlert error={save.error} title="Couldn't save this endpoint." />}
            </div>
          </section>
        ) : created ? (
          <section className="wh-panel">
            <header>
              <span className="h">Your signing secret</span>
              <span className="wh-badge is-ok">
                <Icon name="check" size={14} className="ic-b" />
                endpoint saved
              </span>
            </header>
            <div className="panel-body">
              <div className="wh-alert is-warn" style={{ padding: "10px 12px" }}>
                <Icon name="eye" />
                <div className="body">Copy it now. We only show it once. If you lose it, rotate it from Endpoints.</div>
              </div>
              <Secret secret={created.secret} />
              <p className="hint">
                Store it as{" "}
                <span className="mono" style={{ color: "var(--ink)" }}>
                  WEBHOOK_SECRET
                </span>{" "}
                in your server's environment. Never in the browser or a repo.
              </p>
              <label className="wh-check">
                <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
                I've stored this secret somewhere safe
              </label>
            </div>
          </section>
        ) : (
          <section className="wh-panel">
            <header>
              <span className="h">Endpoint</span>
              <StatusBadge status={endpoint.status} />
            </header>
            <div className="panel-body">
              <div className="wh-secret" style={{ maxWidth: "100%" }}>
                <code>{endpoint.url}</code>
              </div>
              <p className="hint">Its signing secret was shown when the endpoint was created. Lost it? Rotate it from Endpoints; the old one keeps working for 24 hours.</p>
              <div className="wz-inline">
                <Link className="wh-btn is-sm" href="/endpoints">
                  <Icon name="webhook" size={14} />
                  Manage endpoints
                </Link>
              </div>
            </div>
          </section>
        )}

        {createWatch.error && <ErrorAlert error={createWatch.error} title="The endpoint is saved, but your watch couldn't be created." />}
        {watchMissing &&
          (wallet ? (
            <div className="wz-inline">
              <button className="wh-btn" type="button" onClick={() => void createWatch.run(endpoint.id)}>
                <Icon name="rotate" />
                Create the watch for {wallet.label || shortAddress(wallet.address)}
              </button>
              <Link className="wh-btn is-ghost" href="/onboarding/wallet">
                Change the wallet
              </Link>
            </div>
          ) : (
            <div className="wh-alert is-warn" role="status">
              <Icon name="alert-triangle" />
              <div className="body">
                <strong>No wallet yet.</strong> Add the wallet to watch, then come back.
              </div>
              <Link className="wh-btn is-sm" href="/onboarding/wallet">
                Add a wallet
              </Link>
            </div>
          ))}

        <div className="wz-actions">
          <Link className="wh-btn is-ghost" href="/onboarding/wallet">
            <Icon name="arrow-left" />
            Back
          </Link>
          <div className="r">
            <span className="note">{note}</span>
            <button className="wh-btn is-primary" type="button" disabled={!canContinue} onClick={() => router.push("/onboarding/test")}>
              Continue
              <Icon name="arrow-right" />
            </button>
          </div>
        </div>
      </div>
      <aside className="wz-side">
        <div className="wz-card">
          <h3>
            <Icon name="code" size={18} />
            Verify every request
          </h3>
          <p>
            Each webhook carries a{" "}
            <span className="mono" style={{ color: "var(--ink)" }}>
              Webhook-Signature
            </span>{" "}
            header. Check it before you trust the body.
          </p>
          <pre className="wz-code" tabIndex={0} aria-label="Example: verifying a webhook in Express">
            <span className="c">{"// Express: verify, then trust the payload\n"}</span>
            <span className="k">app</span>
            {".post("}
            <span className="s">"/hooks/stellar"</span>
            {", express.raw({ type: "}
            <span className="s">"application/json"</span>
            {" }), (req, res) => {\n  "}
            <span className="k">const</span>
            {" ok = verifyWebhook(process.env.WEBHOOK_SECRET, req.headers, req.body.toString());\n  "}
            <span className="k">if</span>
            {" (!ok) "}
            <span className="k">return</span>
            {" res.sendStatus(400);\n  res.sendStatus(200);\n});"}
          </pre>
          <a className="wh-btn is-sm" href={`${DOCS_URL}/docs/verifying-signatures`} target="_blank" rel="noopener">
            <Icon name="book" size={14} />
            Copy verifyWebhook from the docs
          </a>
        </div>
        <div className="wz-card is-pink">
          <h3>
            <Icon name="laptop" size={18} />
            Testing on your laptop?
          </h3>
          <p>Expose your local server with a tunnel, then paste its https URL.</p>
          <pre className="wz-code" tabIndex={0}>
            npx ngrok http 3000
          </pre>
        </div>
      </aside>
    </div>
  );
}

export default function EndpointStepPage() {
  const setup = useSetup();
  return (
    <SetupFrame setup={setup} step="endpoint">
      <EndpointStep setup={setup} />
    </SetupFrame>
  );
}
