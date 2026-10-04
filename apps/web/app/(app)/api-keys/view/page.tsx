"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Modal } from "@/components/modal";
import { WithId } from "@/components/query";
import { CopyButton, Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { ApiKey } from "@/lib/types";
import { CreatedKeyModal, keyState } from "../page";

function KeyDetail({ id }: { id: string }) {
  const router = useRouter();
  const keys = useApi<{ data: ApiKey[] }>("/v1/api-keys");
  const key = keys.data?.data.find((k) => k.id === id);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<"roll" | "revoke" | "delete">();
  const [typed, setTyped] = useState("");
  const [rolled, setRolled] = useState<{ apiKey: ApiKey; key: string }>();

  const loadedName = key?.name;
  useEffect(() => {
    if (loadedName !== undefined) setName(loadedName);
  }, [loadedName]);

  const rename = useAction(async () => {
    await api(`/v1/api-keys/${id}`, { method: "PATCH", body: { name: name.trim() } });
    setSaved(true);
    keys.reload();
  });
  const roll = useAction(async () => {
    setRolled(await api<{ apiKey: ApiKey; key: string }>(`/v1/api-keys/${id}/roll`, { method: "POST" }));
    setDialog(undefined);
  });
  const remove = useAction(async (permanent: boolean) => {
    await api(`/v1/api-keys/${id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
    setDialog(undefined);
    if (permanent) router.replace("/api-keys");
    else keys.reload();
  });

  if (keys.error && !keys.data) return <ErrorAlert error={keys.error} title="Couldn't load this key." onRetry={keys.reload} />;
  if (!keys.data) return <div aria-busy="true" />;
  if (!key) {
    return (
      <Empty icon="search" title="Key not found" actions={<Link className="wh-btn" href="/api-keys">Back to API keys</Link>}>
        It may have been deleted, or the link is wrong.
      </Empty>
    );
  }

  const state = keyState(key);
  const active = state.status === "ACTIVE";
  const close = () => {
    setDialog(undefined);
    setTyped("");
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
          <Icon name="circle-off" />
          <div className="body">
            <strong>This key is revoked.</strong> Requests that use it get 401. You can delete it from your account.
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
              {saved && !rename.pending && (
                <span className="kd-saved" role="status">
                  <Icon name="check" size={14} className="ic-b" />
                  Saved
                </span>
              )}
            </header>
            <div className="panel-body">
              {active ? (
                <>
                  <div className="wh-field">
                    <label htmlFor="key-name">Name</label>
                    <input
                      id="key-name"
                      className="wh-input"
                      maxLength={100}
                      value={name}
                      aria-invalid={!name.trim() ? true : undefined}
                      onChange={(e) => {
                        setName(e.target.value);
                        setSaved(false);
                      }}
                    />
                    {!name.trim() && (
                      <span className="wh-help is-bad">
                        <Icon name="alert-circle" />A key needs a name.
                      </span>
                    )}
                  </div>
                  <div className="wz-inline">
                    <button className="wh-btn is-primary" type="button" disabled={!name.trim() || name.trim() === key.name || rename.pending} onClick={() => void rename.run()}>
                      <Icon name="save" />
                      Save changes
                    </button>
                    <button className="wh-btn is-ghost" type="button" disabled={name === key.name} onClick={() => setName(key.name)}>
                      Undo
                    </button>
                  </div>
                  {rename.error && <ErrorAlert error={rename.error} title="Couldn't rename this key." />}
                </>
              ) : (
                <dl className="wh-dl is-plain" style={{ gridTemplateColumns: "120px minmax(0, 1fr)" }}>
                  <dt>Name</dt>
                  <dd style={{ fontFamily: "var(--font-sans)" }}>{key.name}</dd>
                </dl>
              )}
            </div>
          </section>
          <section className="wh-panel">
            <header>
              <span className="h">Access</span>
            </header>
            <div className="panel-body">
              <p className="hint" style={{ margin: 0 }}>
                This key can do everything your account can through the API: read payments and events, and manage watches and endpoints. It cannot create, roll or revoke API keys; that needs you to be logged in.
              </p>
            </div>
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
              <dt>Created</dt>
              <dd>{dateTime(key.createdAt)}</dd>
              <dt>Last used</dt>
              <dd>{key.lastUsedAt ? dateTime(key.lastUsedAt) : "never"}</dd>
            </dl>
          </div>
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
                      <span>Stops it working immediately. Keeps it in your list.</span>
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
                  <span>Revokes it if needed and removes it from your account.</span>
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
            Requests using <span className="mono">{key.prefix}…</span> start failing with 401 straight away, so whatever uses it will break. You can't undo this.
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
            <dd style={{ fontFamily: "var(--font-sans)" }}>You get a new secret, shown once. Both old and new work.</dd>
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
            This revokes the key if it's still active and removes it from your account. You can't undo this.
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
