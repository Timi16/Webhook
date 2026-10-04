"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { TableSkeleton } from "@/components/list";
import { Modal } from "@/components/modal";
import { SecretModal } from "@/components/secret";
import { Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { DOCS_URL } from "@/lib/constants";
import { dateTime, relativeTime } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { ApiKey } from "@/lib/types";

const COLUMNS = ["Name", "Key", "Created", "Last used", "Status", ""];

/** A rolled key carries its end date in revokedAt; until then it still works. */
export function keyState(key: ApiKey): { status: "ACTIVE" | "REVOKED"; endsAt: string | null } {
  if (!key.revokedAt) return { status: "ACTIVE", endsAt: null };
  return new Date(key.revokedAt).getTime() > Date.now() ? { status: "ACTIVE", endsAt: key.revokedAt } : { status: "REVOKED", endsAt: null };
}

export function CreatedKeyModal({ name, secret, onDone }: { name: string; secret: string; onDone: () => void }) {
  return (
    <SecretModal title="Your new API key" label={<>Key for “{name}”</>} secret={secret} onDone={onDone}>
      Send it as <span className="mono" style={{ color: "var(--ink)" }}>Authorization: Bearer whk_test_…</span>. Store it in your server's environment, never in the browser or a repo. If you lose it, roll the key to get a new one.
    </SecretModal>
  );
}

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ apiKey: ApiKey; key: string }>();
  const create = useAction(async () => {
    setCreated(await api<{ apiKey: ApiKey; key: string }>("/v1/api-keys", { method: "POST", body: { name: name.trim() } }));
    onCreated();
  });
  if (created) return <CreatedKeyModal name={created.apiKey.name} secret={created.key} onDone={onClose} />;
  return (
    <Modal
      title="Create an API key"
      onClose={onClose}
      footer={
        <>
          <button className="wh-btn is-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="wh-btn is-primary" type="button" disabled={!name.trim() || create.pending} onClick={() => void create.run()}>
            <Icon name="key" />
            {create.pending ? "Creating…" : "Create key"}
          </button>
        </>
      }
    >
      <div className="wh-field">
        <label htmlFor="key-name">Name</label>
        <input id="key-name" className="wh-input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments worker" />
        <span className="hint">Name it after where it lives, so you know what breaks if you revoke it.</span>
      </div>
      <p className="hint">A key can do everything your account can through the API, except manage API keys.</p>
      {create.error && (
        <div className="wh-help is-bad" role="alert">
          <Icon name="alert-circle" />
          <span>{create.error.message}</span>
        </div>
      )}
    </Modal>
  );
}

export default function ApiKeysPage() {
  const keys = useApi<{ data: ApiKey[] }>("/v1/api-keys");
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ key: ApiKey; permanent: boolean }>();
  const rows = keys.data?.data ?? [];
  const remove = useAction(async (key: ApiKey, permanent: boolean) => {
    await api(`/v1/api-keys/${key.id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
    setConfirm(undefined);
    keys.reload();
  });
  const createButton = (
    <button className="wh-btn is-primary" type="button" onClick={() => setCreating(true)}>
      <Icon name="plus" />
      Create key
    </button>
  );
  const href = (key: ApiKey) => `/api-keys/view?id=${key.id}`;

  return (
    <>
      <PageHead title="API keys" sub="Use these to call the API from your server. Keep them out of client code and git." actions={createButton} />
      {keys.error && !keys.data ? (
        <ErrorAlert error={keys.error} title="Couldn't load API keys." onRetry={keys.reload} />
      ) : !keys.data ? (
        <TableSkeleton columns={COLUMNS.slice(0, 5)} widths={[120, 110, 96, 96, 72]} />
      ) : rows.length === 0 ? (
        <Empty
          icon="key"
          title="Create your first API key"
          actions={
            <>
              {createButton}
              <a className="wh-btn" href={`${DOCS_URL}/api-reference`} target="_blank" rel="noopener">
                <Icon name="book" />
                Read the API docs
              </a>
            </>
          }
        >
          You need a key to create watches and read payments from your own code.
        </Empty>
      ) : (
        <div className="wh-resp">
          <table className="wh-table">
            <caption className="sr-only">API keys</caption>
            <thead>
              <tr>
                {COLUMNS.map((c, i) => (
                  <th scope="col" key={i} className={c === "" ? "num" : undefined}>
                    {c || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((key) => {
                const state = keyState(key);
                return (
                  <tr key={key.id} className={state.status === "REVOKED" ? "is-revoked" : undefined}>
                    <td style={{ fontFamily: "var(--font-sans)" }}>
                      <Link className="rowlink" href={href(key)}>
                        {key.name}
                      </Link>
                    </td>
                    <td>{key.prefix}…</td>
                    <td className="muted">{dateTime(key.createdAt)}</td>
                    <td className="muted">{key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}</td>
                    <td style={{ paddingTop: 8, paddingBottom: 8 }}>
                      <StatusBadge status={state.status} />
                      {state.endsAt && <div className="wh-reason">rolled · works until {dateTime(state.endsAt)}</div>}
                    </td>
                    <td className="num">
                      <span className="key-actions">
                        <Link className="wh-btn is-sm" href={href(key)}>
                          <Icon name="pencil" size={14} />
                          Manage
                        </Link>
                        {state.status === "ACTIVE" ? (
                          <button className="wh-btn is-sm is-danger" type="button" onClick={() => setConfirm({ key, permanent: false })}>
                            Revoke
                          </button>
                        ) : (
                          <button className="wh-btn is-sm is-danger" type="button" onClick={() => setConfirm({ key, permanent: true })}>
                            <Icon name="trash" size={14} />
                            Delete
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wh-stack">
            {rows.map((key) => (
              <Link href={href(key)} key={key.id}>
                <div className="top">
                  <span style={{ fontFamily: "var(--font-sans)", fontWeight: 600 }}>{key.name}</span>
                  <StatusBadge status={keyState(key).status} />
                </div>
                <dl>
                  <dt>Key</dt>
                  <dd>{key.prefix}…</dd>
                  <dt>Created</dt>
                  <dd>{dateTime(key.createdAt)}</dd>
                  <dt>Last used</dt>
                  <dd>{key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}</dd>
                </dl>
              </Link>
            ))}
          </div>
        </div>
      )}
      {creating && <CreateKey onClose={() => setCreating(false)} onCreated={keys.reload} />}
      {confirm && (
        <Modal
          title={confirm.permanent ? `Delete ${confirm.key.name}?` : `Revoke ${confirm.key.name}?`}
          onClose={() => setConfirm(undefined)}
          footer={
            <>
              <button className="wh-btn is-ghost" type="button" onClick={() => setConfirm(undefined)}>
                Keep key
              </button>
              <button className="wh-btn is-danger" type="button" disabled={remove.pending} onClick={() => void remove.run(confirm.key, confirm.permanent)}>
                {confirm.permanent ? "Delete key" : "Revoke key"}
              </button>
            </>
          }
        >
          <p className="hint" style={{ color: "var(--ink)" }}>
            {confirm.permanent ? (
              <>This removes the revoked key from your account. You can't undo this.</>
            ) : (
              <>
                Requests using <span className="mono">{confirm.key.prefix}…</span> start failing with 401 straight away, so whatever uses it will break. You can't undo this.
              </>
            )}
          </p>
          {remove.error && <ErrorAlert error={remove.error} title="That didn't work." />}
        </Modal>
      )}
    </>
  );
}
