"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { Modal } from "./modal";

/**
 * Shows a secret exactly once: masked until revealed, with a copy button, and it can only be
 * dismissed after the reader confirms they stored it.
 */
export function SecretModal({
  title,
  label,
  secret,
  children,
  onDone,
}: {
  title: string;
  label: ReactNode;
  secret: string;
  children: ReactNode;
  onDone: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Keep the recognisable prefix (whsec_, whk_test_) and hide the rest.
  const prefix = /^[a-z]+_(?:[a-z]+_)?/.exec(secret)?.[0] ?? "";
  const masked = `${prefix}${"•".repeat(24)}`;

  return (
    <Modal
      title={title}
      // Closing with Escape would throw the secret away unread, so it is deliberately a no-op.
      onClose={() => {}}
      footer={
        <button className="wh-btn is-primary" type="button" disabled={!stored} onClick={onDone}>
          Done
        </button>
      }
    >
      <div className="wh-alert is-warn" style={{ padding: "10px 12px" }}>
        <Icon name="eye" />
        <div className="body">Copy it now. We only show it once.</div>
      </div>
      <div className="wh-field">
        <label htmlFor="secret-value">{label}</label>
        <div className="wh-secret">
          <code id="secret-value">{shown ? secret : masked}</code>
          <button
            className="wh-copy"
            type="button"
            aria-label={shown ? "Hide" : "Reveal"}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            <Icon name={shown ? "eye-off" : "eye"} size={14} />
          </button>
          <button
            className="wh-copy"
            type="button"
            aria-label="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(secret).then(() => setCopied(true));
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <p className="hint">{children}</p>
      <label className="wh-check">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        I've stored this somewhere safe
      </label>
    </Modal>
  );
}
