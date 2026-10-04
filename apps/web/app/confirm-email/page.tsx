"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthPage } from "@/components/auth";
import { Icon } from "@/components/icons";
import { api, ApiError } from "@/lib/api";
import type { Developer } from "@/lib/types";

function Confirm() {
  const token = useSearchParams().get("token");
  const [result, setResult] = useState<{ email: string } | { error: string }>();

  useEffect(() => {
    if (!token) {
      setResult({ error: "This link is missing its token. Open the link from the email again." });
      return;
    }
    let cancelled = false;
    api<{ developer: Developer }>("/auth/email/confirm", { method: "POST", body: { token } }).then(
      ({ developer }) => {
        if (!cancelled) setResult({ email: developer.email });
      },
      (error: unknown) => {
        if (cancelled) return;
        const taken = error instanceof ApiError && error.code === "CONFLICT";
        setResult({
          error: taken
            ? "Another account already uses that email address."
            : "This link is invalid, has expired or was already used. Request a new one from Settings.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthPage
      title="Confirm your email"
      hint="This makes the new address your login."
      footer={
        <>
          <Link href="/settings">Back to settings</Link> · <Link href="/login">Log in</Link>
        </>
      }
    >
      {!result ? (
        <p className="hint" role="status">
          Confirming…
        </p>
      ) : "email" in result ? (
        <div className="wh-alert is-neutral" role="status">
          <Icon name="check-circle" />
          <div className="body">
            <strong>Email updated.</strong> You now log in with{" "}
            <span className="mono">{result.email}</span>.
          </div>
        </div>
      ) : (
        <div className="wh-alert is-bad" role="alert">
          <Icon name="alert-circle" />
          <div className="body">{result.error}</div>
        </div>
      )}
    </AuthPage>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Suspense>
      <Confirm />
    </Suspense>
  );
}
