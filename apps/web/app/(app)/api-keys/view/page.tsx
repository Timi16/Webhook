"use client";

import { isIpRule } from "@webhook/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import { WithId } from "@/components/query";
import { CopyButton, Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { clockTime, dateTime, duration, percent, relativeTime } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import { keyState, SCOPES } from "@/lib/keys";
import type { ApiKey, ApiKeyDetail } from "@/lib/types";
import { CreatedKeyModal } from "../page";

const METHOD_CLASS: Record<string, string> = { POST: "post", PATCH: "patch", DELETE: "del" };

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="kd-saved" role="status">
      <Icon name="check" size={14} className="ic-b" />
      Saved
    </span>
  ) : null;
}

function Usage({ usage }: { usage: ApiKeyDetail["usage"] }) {
  const peak = Math.max(1, ...usage.hourly.map((h) => h.requests));
  return (
    <section className="wh-panel">
      <header>
        <span className="h">Last 24 hours</span>
      </header>
      <div className="panel-body">
        <div className="kd-nums">
          <div>
            <b>{usage.requests.toLocaleString("en-GB")}</b>
            <span>requests</span>
          </div>
          <div>
            <b>{percent(usage.errors, usage.requests)}</b>
            <span>errors</span>
          </div>
          <div>
            <b>{usage.medianMs === null ? "—" : duration(usage.medianMs)}</b>
            <span>median</span>
          </div>
        </div>
        <div className="kd-usage" role="img" aria-label={`Requests per hour over the last 24 hours: ${usage.requests} in total, ${usage.errors} with errors.`}>
          {usage.hourly.map((hour, i) => (
            <i
              key={hour.hour}
              className={hour.errors > 0 ? "err" : undefined}
              title={`${clockTime(hour.hour).slice(0, 5)} · ${hour.requests} requests, ${hour.errors} errors`}
              style={{ height: `${hour.requests === 0 ? 2 : Math.max(6, Math.round((hour.requests / peak) * 100))}%`, animationDelay: `${i * 20}ms`, opacity: hour.requests === 0 ? 0.35 : undefined }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function KeyDetail({ id }: { id: string }) {
  const router = useRouter();
  const detail = useApi<ApiKeyDetail>(`/v1/api-keys/${id}`);
  const key = detail.data?.apiKey;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [ipDraft, setIpDraft] = useState("");
  const [ipError, setIpError] = useState(false);
  const [saved, setSaved] = useState<"details" | "scopes">();
  const [dialog, setDialog] = useState<"roll" | "revoke" | "delete">();
  const [typed, setTyped] = useState("");
  const [rolled, setRolled] = useState<{ apiKey: ApiKey; key: string }>();

  // The forms start from the saved key and follow it after each save.
  const loaded = key ? `${key.name}\n${key.note ?? ""}\n${key.scopes.join()}` : undefined;
  useEffect(() => {
    if (!key) return;
    setName(key.name);
    setNote(key.note ?? "");
    setScopes(key.scopes);
  }, [loaded]);

  const patch = (body: Record<string, unknown>) => api(`/v1/api-keys/${id}`, { method: "PATCH", body });
  const saveDetails = useAction(async () => {
    await patch({ name: name.trim(), note: note.trim() || null });
    setSaved("details");
    detail.reload();
  });
  const saveScopes = useAction(async () => {
    await patch({ scopes });
    setSaved("scopes");
    detail.reload();
  });
  const saveIps = useAction(async (allowedIps: string[]) => {
    await patch({ allowedIps });
    setIpDraft("");
    detail.reload();
  });
  const roll = useAction(async () => {
    setRolled(await api<{ apiKey: ApiKey; key: string }>(`/v1/api-keys/${id}/roll`, { method: "POST" }));
    setDialog(undefined);
  });
  const remove = useAction(async (permanent: boolean) => {
    await api(`/v1/api-keys/${id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
    setDialog(undefined);
    if (permanent) router.replace("/api-keys");
    else detail.reload();
  });

  if (detail.error && !detail.data) {
    return detail.error.status === 404 ? (
      <Empty icon="search" title="Key not found" actions={<Link className="wh-btn" href="/api-keys">Back to API keys</Link>}>
        It may have been deleted, or the link is wrong.
      </Empty>
    ) : (
      <ErrorAlert error={detail.error} title="Couldn't load this key." onRetry={detail.reload} />
    );
  }
  if (!detail.data || !key) return <div aria-busy="true" />;

  const { usage, recentRequests } = detail.data;
  const state = keyState(key);
  const active = state.status === "ACTIVE";
  const close = () => {
    setDialog(undefined);
    setTyped("");
  };
  const detailsChanged = name.trim() !== key.name || (note.trim() || null) !== key.note;
  const scopesChanged = [...scopes].sort().join() !== [...key.scopes].sort().join();
  const addIp = () => {
    const value = ipDraft.trim();
    if (!isIpRule(value)) {
      setIpError(true);
      return;
    }
    if (key.allowedIps.includes(value)) setIpDraft("");
    else void saveIps.run([...key.allowedIps, value]);
  };

  return (
    <>
      <PageHead
        back={{ href: "/api-keys", label: "API keys" }}
        title={key.name}
        sub={`Created ${dateTime(key.createdAt)} · last used ${key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}`}
        actions={<StatusBadge status={state.status} />}
      />
      {!active && (
        <div className="wh-alert is-neutral" role="status">
          <Icon name={state.status === "EXPIRED" ? "clock" : "circle-off"} />
          <div className="body">
            <strong>This key {state.status === "EXPIRED" ? "has expired" : "is revoked"}.</strong> Requests that use it get 401. You can still read its history, or delete it.
          </div>
        </div>
      )}
      {state.endsAt && (
        <div className="wh-alert is-warn" role="status">
          <Icon name="rotate" />
          <div className="body">
            <strong>This key was rolled.</strong> It keeps working until {dateTime(state.endsAt)}. Deploy its replacement before then.
          </div>
        </div>
      )}
      <div className="kd-grid">
        <div className="kd-col">
          <section className="wh-panel">
            <header>
              <span className="h">Details</span>
              <Saved show={saved === "details" && !detailsChanged && !saveDetails.pending} />
            </header>
            <div className="panel-body">
              {active ? (
                <>
                  <div className="wh-field">
                    <label htmlFor="key-name">Name</label>
                    <input id="key-name" className="wh-input" maxLength={100} value={name} aria-invalid={!name.trim() ? true : undefined} onChange={(e) => setName(e.target.value)} />
                    {!name.trim() && (
                      <span className="wh-help is-bad">
                        <Icon name="alert-circle" />A key needs a name.
                      </span>
                    )}
                  </div>
                  <div className="wh-field">
                    <label htmlFor="key-note">
                      Note{" "}
                      <span className="muted" style={{ fontWeight: 400 }}>
                        (optional)
                      </span>
                    </label>
                    <input id="key-note" className="wh-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where it's deployed, who owns it" />
                  </div>
                  <div className="wz-inline">
                    <button className="wh-btn is-primary" type="button" disabled={!name.trim() || !detailsChanged || saveDetails.pending} onClick={() => void saveDetails.run()}>
                      <Icon name="save" />
                      Save changes
                    </button>
                    <button
                      className="wh-btn is-ghost"
                      type="button"
                      disabled={!detailsChanged}
                      onClick={() => {
                        setName(key.name);
                        setNote(key.note ?? "");
                      }}
                    >
                      Undo
                    </button>
                  </div>
                  {saveDetails.error && <ErrorAlert error={saveDetails.error} title="Couldn't save this key." />}
                </>
              ) : (
                <dl className="wh-dl is-plain" style={{ gridTemplateColumns: "120px minmax(0, 1fr)" }}>
                  <dt>Name</dt>
                  <dd style={{ fontFamily: "var(--font-sans)" }}>{key.name}</dd>
                  <dt>Note</dt>
                  <dd style={{ fontFamily: "var(--font-sans)" }}>{key.note ?? "—"}</dd>
                </dl>
              )}
            </div>
          </section>

          <section className="wh-panel">
            <header>
              <span className="h">Permissions</span>
              <Saved show={saved === "scopes" && !scopesChanged && !saveScopes.pending} />
            </header>
            <div className="panel-body">
              {active ? (
                <>
                  <p className="hint" style={{ margin: 0 }}>
                    Give each key only what its job needs. Changes apply to the next request. Every key can list your watches and endpoints.
                  </p>
                  <div className="kd-scopes">
                    {SCOPES.map((scope) => {
                      const on = scopes.includes(scope.value);
                      return (
                        <label className={on ? "kd-scope is-on" : "kd-scope"} key={scope.value}>
                          <input type="checkbox" checked={on} onChange={() => setScopes(on ? scopes.filter((s) => s !== scope.value) : [...scopes, scope.value])} />
                          <span>
                            <b>{scope.value}</b>
                            <span>{scope.label}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {scopes.length === 0 && (
                    <div className="wh-help is-bad" role="alert">
                      <Icon name="alert-circle" />
                      <span>Keep at least one permission, or revoke the key instead.</span>
                    </div>
                  )}
                  <div className="wz-inline">
                    <button className="wh-btn" type="button" disabled={scopes.length === 0 || !scopesChanged || saveScopes.pending} onClick={() => void saveScopes.run()}>
                      <Icon name="save" />
                      Save permissions
                    </button>
                  </div>
                  {saveScopes.error && <ErrorAlert error={saveScopes.error} title="Couldn't save the permissions." />}
                </>
              ) : (
                <div className="kd-ro">
                  {key.scopes.map((scope) => (
                    <span className="scope-chip" key={scope}>
                      {scope}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="wh-panel">
            <header>
              <span className="h">Allowed IPs</span>
              <span className="wh-reason">{key.allowedIps.length === 0 ? "any IP" : key.allowedIps.length === 1 ? "1 rule" : `${key.allowedIps.length} rules`}</span>
            </header>
            <div className="panel-body">
              <p className="hint" style={{ margin: 0 }}>
                Only requests from these addresses can use the key. Leave it empty to allow any IP.
              </p>
              {key.allowedIps.length > 0 && (
                <div className="kd-ips">
                  {key.allowedIps.map((ip) => (
                    <span className="kd-ip" key={ip}>
                      {ip}
                      {active && (
                        <button className="wh-copy" type="button" aria-label={`Remove ${ip}`} disabled={saveIps.pending} onClick={() => void saveIps.run(key.allowedIps.filter((x) => x !== ip))}>
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {active && (
                <>
                  <div className="wz-inline">
                    <input
                      className="wh-input mono"
                      style={{ maxWidth: 260 }}
                      aria-label="Add IP or CIDR range"
                      aria-invalid={ipError ? true : undefined}
                      value={ipDraft}
                      placeholder="203.0.113.0/24"
                      onChange={(e) => {
                        setIpDraft(e.target.value);
                        setIpError(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addIp();
                      }}
                    />
                    <button className="wh-btn" type="button" disabled={saveIps.pending} onClick={addIp}>
                      <Icon name="plus" />
                      Add IP
                    </button>
                  </div>
                  {ipError && (
                    <div className="wh-help is-bad" role="alert">
                      <Icon name="alert-circle" />
                      <span>Enter an IPv4 address or CIDR range, like 203.0.113.7 or 203.0.113.0/24.</span>
                    </div>
                  )}
                  {saveIps.error && <ErrorAlert error={saveIps.error} title="Couldn't save the allowed IPs." />}
                </>
              )}
            </div>
          </section>

          <section className="stack">
            <h2 className="section-title">Recent requests</h2>
            {recentRequests.length === 0 ? (
              <p className="hint">No requests in the last 7 days.</p>
            ) : (
              <div className="wh-resp">
                <table className="wh-table">
                  <caption className="sr-only">Recent requests made with this key</caption>
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Method</th>
                      <th scope="col">Path</th>
                      <th scope="col">Status</th>
                      <th scope="col">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRequests.map((request) => (
                      <tr key={request.id}>
                        <td className="muted" title={dateTime(request.at)}>
                          {clockTime(request.at)}
                        </td>
                        <td>
                          <span className={`kd-method ${METHOD_CLASS[request.method] ?? ""}`}>{request.method}</span>
                        </td>
                        <td style={{ overflowWrap: "anywhere" }}>{request.path}</td>
                        <td>
                          <span className={request.status >= 400 ? "wh-badge is-bad" : "wh-badge is-ok"}>{request.status}</span>
                        </td>
                        <td className="muted">{request.ip ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="wh-stack">
                  {recentRequests.map((request) => (
                    <div key={request.id} style={{ padding: "12px 16px" }}>
                      <div className="top">
                        <span className="mono" style={{ overflowWrap: "anywhere" }}>
                          {request.method} {request.path}
                        </span>
                        <span className={request.status >= 400 ? "wh-badge is-bad" : "wh-badge is-ok"}>{request.status}</span>
                      </div>
                      <span className="fine">
                        {clockTime(request.at)} · {request.ip ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className="kd-col">
          <div className={active ? "kd-key" : "kd-key is-revoked"}>
            <span className="k">Secret key</span>
            <code>{key.prefix}••••••••••••••••••••</code>
            <p>We only show a full key once, when it's created. Lost it? Roll the key to get a new one.</p>
            <dl>
              <dt>Key ID</dt>
              <dd>
                {key.id} <CopyButton value={key.id} label="Copy key ID" />
              </dd>
              <dt>Expires</dt>
              <dd>{key.expiresAt ? dateTime(key.expiresAt) : "Never"}</dd>
              <dt>Last IP</dt>
              <dd>{key.lastUsedIp ?? "—"}</dd>
            </dl>
          </div>
          <Usage usage={usage} />
          <section className="wh-panel danger-zone">
            <header>
              <span className="h">
                <Icon name="alert-triangle" />
                Danger zone
              </span>
            </header>
            <div className="kd-danger">
              {active && (
                <>
                  <div className="row">
                    <div>
                      <b>Roll key</b>
                      <span>Get a new secret. The old one keeps working for 24 hours so you can deploy.</span>
                    </div>
                    <button className="wh-btn is-sm" type="button" disabled={state.endsAt !== null} onClick={() => setDialog("roll")}>
                      <Icon name="rotate" size={14} />
                      Roll
                    </button>
                  </div>
                  <div className="row">
                    <div>
                      <b>Revoke key</b>
                      <span>Stops it working immediately. Keeps its history.</span>
                    </div>
                    <button className="wh-btn is-sm is-danger" type="button" onClick={() => setDialog("revoke")}>
                      Revoke
                    </button>
                  </div>
                </>
              )}
              <div className="row">
                <div>
                  <b>Delete key</b>
                  <span>Revokes it if needed and removes it and its history from your account.</span>
                </div>
                <button className="wh-btn is-sm is-danger" type="button" onClick={() => setDialog("delete")}>
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              </div>
            </div>
          </section>
        </aside>
      </div>

      {dialog === "revoke" && (
        <Modal
          title={`Revoke ${key.name}?`}
          onClose={close}
          footer={
            <>
              <button className="wh-btn is-ghost" type="button" onClick={close}>
                Keep key
              </button>
              <button className="wh-btn is-danger" type="button" disabled={remove.pending} onClick={() => void remove.run(false)}>
                Revoke key
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            Requests using <span className="mono">{key.prefix}…</span> start failing with 401 straight away.{" "}
            {usage.requests > 0 ? `It made ${usage.requests.toLocaleString("en-GB")} ${usage.requests === 1 ? "request" : "requests"} in the last 24 hours, so whatever uses it will break. ` : ""}
            You can't undo this.
          </p>
          {remove.error && <ErrorAlert error={remove.error} title="Couldn't revoke this key." />}
        </Modal>
      )}
      {dialog === "roll" && (
        <Modal
          title="Roll this key?"
          onClose={close}
          footer={
            <>
              <button className="wh-btn is-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="wh-btn is-primary" type="button" disabled={roll.pending} onClick={() => void roll.run()}>
                <Icon name="rotate" />
                Roll key
              </button>
            </>
          }
        >
          <dl className="wh-dl is-plain" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
            <dt>Now</dt>
            <dd style={{ fontFamily: "var(--font-sans)" }}>You get a new secret, shown once, with the same permissions and IP rules. Both old and new work.</dd>
            <dt>+24 hours</dt>
            <dd style={{ fontFamily: "var(--font-sans)" }}>The old secret stops working. Deploy the new one before then.</dd>
          </dl>
          {roll.error && <ErrorAlert error={roll.error} title="Couldn't roll this key." />}
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title={`Delete ${key.name}?`}
          onClose={close}
          footer={
            <>
              <button className="wh-btn is-ghost" type="button" onClick={close}>
                Cancel
              </button>
              <button className="wh-btn is-danger" type="button" disabled={typed !== key.name || remove.pending} onClick={() => void remove.run(true)}>
                <Icon name="trash" />
                Delete key
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            This revokes the key if it's still active and removes it and its request history. You can't undo this.
          </p>
          <div className="wh-field">
            <label htmlFor="delete-confirm">
              Type <span className="mono">{key.name}</span> to confirm
            </label>
            <input id="delete-confirm" className="wh-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={key.name} />
          </div>
          {remove.error && <ErrorAlert error={remove.error} title="Couldn't delete this key." />}
        </Modal>
      )}
      {rolled && (
        <CreatedKeyModal
          name={rolled.apiKey.name}
          secret={rolled.key}
          onDone={() => {
            setRolled(undefined);
            router.replace(`/api-keys/view?id=${rolled.apiKey.id}`);
          }}
        />
      )}
    </>
  );
}

export default function ApiKeyViewPage() {
  return <WithId>{(id) => <KeyDetail id={id} />}</WithId>;
}
