"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { SystemPage } from "@/components/system";
import { CopyButton } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SystemPage code="error" title="Something broke on our side">
      <p className="hint" style={{ fontSize: 14 }}>
        It's not your code. Your watches keep running and webhooks keep retrying while this page is broken. Try again in a minute.
      </p>
      {error.digest && (
        <div className="result">
          <span>error ID</span>
          <strong style={{ color: "var(--ink)" }}>{error.digest}</strong>
          <CopyButton value={error.digest} label="Copy error ID" />
        </div>
      )}
      <div className="wh-row">
        <button className="wh-btn is-primary" type="button" onClick={reset}>
          <Icon name="rotate" />
          Try again
        </button>
        <Link className="wh-btn" href="/overview">
          Go to overview
        </Link>
      </div>
    </SystemPage>
  );
}
