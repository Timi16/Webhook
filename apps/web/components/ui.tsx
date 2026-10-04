"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { ApiError } from "@/lib/api";
import { shortAddress, splitAmount } from "@/lib/format";
import { Icon, type IconName } from "./icons";

type Tone = "ok" | "warn" | "bad" | "neutral";

/** Every status in the product, with the tone, icon and word the design gives it. */
const STATUSES: Record<string, { tone: Tone; icon: IconName; label: string }> = {
  VERIFIED: { tone: "ok", icon: "check", label: "verified" },
  REJECTED: { tone: "bad", icon: "x", label: "rejected" },
  DELIVERED: { tone: "ok", icon: "check-check", label: "delivered" },
  RETRYING: { tone: "warn", icon: "rotate", label: "retrying" },
  FAILED: { tone: "bad", icon: "alert-circle", label: "failed" },
  PENDING: { tone: "neutral", icon: "clock", label: "pending" },
  SENDING: { tone: "neutral", icon: "clock", label: "sending" },
  CANCELLED: { tone: "neutral", icon: "minus", label: "cancelled" },
  ACTIVE: { tone: "ok", icon: "activity", label: "active" },
  FAILING: { tone: "warn", icon: "alert-triangle", label: "failing" },
  DISABLED: { tone: "bad", icon: "ban", label: "disabled" },
  PAUSED: { tone: "neutral", icon: "pause", label: "paused" },
  REVOKED: { tone: "neutral", icon: "circle-off", label: "revoked" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUSES[status] ?? {
    tone: "neutral" as const,
    icon: "minus" as const,
    label: status.toLowerCase(),
  };
  return (
    <span className={`wh-badge is-${s.tone}`}>
      <Icon name={s.icon} size={14} className="ic-b" />
      {s.label}
    </span>
  );
}

/** "19.5" + muted "000000" + asset code, as the design prints every amount. */
export function Amount({ amount, code, large }: { amount: string; code: string; large?: boolean }) {
  const { value, zeros } = splitAmount(amount);
  return (
    <span className={large ? "wh-amt is-lg" : "wh-amt"}>
      {value}
      {zeros && <span className="z">{zeros}</span>}
      <span className="code">{code}</span>
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="wh-copy"
      type="button"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

/** A shortened address with its full value available to copy and on hover. */
export function Address({ value, label = "Copy address" }: { value: string; label?: string }) {
  return (
    <span className="wh-addr" title={value}>
      {shortAddress(value)} <CopyButton value={value} label={label} />
    </span>
  );
}

export function ErrorAlert({
  error,
  title,
  onRetry,
}: {
  error: ApiError;
  title: string;
  onRetry?: () => void;
}) {
  return (
    <div className="wh-alert is-bad" role="alert">
      <Icon name="alert-circle" />
      <div className="body">
        <strong>{title}</strong> {error.message}
      </div>
      {onRetry && (
        <button className="wh-btn is-sm" type="button" onClick={onRetry}>
          <Icon name="rotate" />
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  actions,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="wh-empty">
      <span className="ico">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {actions && <div className="wh-row">{actions}</div>}
    </div>
  );
}

export function Skeleton({ width, height = 12 }: { width: number | string; height?: number }) {
  return <span className="wh-skel" style={{ width, height }} />;
}

export function PageHead({
  title,
  sub,
  actions,
  back,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="page-head">
      {back && (
        <Link className="back" href={back.href}>
          <Icon name="arrow-left" />
          {back.label}
        </Link>
      )}
      <div className="ph-row">
        <div className="ph-text">
          <h1>{title}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {actions && <div className="wh-row">{actions}</div>}
      </div>
    </header>
  );
}

/** A field's label, control, hint and error, wired together for screen readers. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  labelAside,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  labelAside?: ReactNode;
}) {
  return (
    <div className={error ? "wh-field has-error" : "wh-field"}>
      {labelAside ? (
        <div className="label-row">
          <label htmlFor={id}>{label}</label>
          {labelAside}
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {children}
      {error ? (
        <span id={`${id}-error`} className="wh-help is-bad" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </span>
      ) : (
        hint && (
          <span id={`${id}-hint`} className="hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}
