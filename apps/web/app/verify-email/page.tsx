"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthPage } from "@/components/auth";
import { Icon } from "@/components/icons";
import { Field } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import type { Developer } from "@/lib/types";

const RESEND_WAIT_SECONDS = 60;

/** Plain words for what can be wrong with a code. */
const ISSUES: Record<string, string> = {
  invalid_code: "That code isn't right. Check the email and try again.",
  code_expired: "That code has expired. Send a new one below.",
  too_many_attempts: "Too many wrong tries. Send a new code below.",
};

/** The step between signing up and using the account: enter the code we emailed. */
export default function VerifyEmailPage() {
  const router = useRouter();
  const me = useApi<{ developer: Developer }>("/auth/me");
  const developer = me.data?.developer;
  const [code, setCode] = useState("");
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);
  const [resent, setResent] = useState(false);

  // Not logged in: nothing to verify. Already verified: carry on.
  const loggedOut = me.error?.status === 401;
  const verified = developer?.emailVerified === true;
  useEffect(() => {
    if (loggedOut) router.replace("/login");
    else if (verified) router.replace("/overview");
  }, [loggedOut, verified, router]);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const verify = useAction(async () => {
    try {
      await api("/auth/verify", { method: "POST", body: { code } });
    } catch (error) {
      // Already verified (a double submit, or another tab): that is success too.
      if (!(error instanceof ApiError && error.code === "CONFLICT")) throw error;
    }
    router.replace("/onboarding/wallet");
  });
  const resend = useAction(async () => {
    await api("/auth/verify/resend", { method: "POST" });
    setResent(true);
    setCode("");
    setWait(RESEND_WAIT_SECONDS);
    verify.clearError();
  });
  const logout = useAction(async () => {
    await api("/auth/logout", { method: "POST" });
    router.replace("/signup");
  });

  const issue = verify.error?.issueFor("code");
  const codeError = issue ? (ISSUES[issue] ?? "Enter the 6-digit code from the email.") : undefined;
  const otherError =
    (verify.error && !issue ? verify.error.message : undefined) ?? resend.error?.message;

  if (!developer || verified) return <div className="auth" aria-busy="true" />;

  return (
    <AuthPage
      title="Check your email"
      hint={`We sent a 6-digit code to ${developer.email}. Enter it to finish creating your account.`}
      footer={
        <>
          Wrong address?{" "}
          <button
            className="linklike"
            type="button"
            disabled={logout.pending}
            onClick={() => void logout.run()}
          >
            Sign up again
          </button>
        </>
      }
    >
      <form
        className="auth-form"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (code.length === 6) void verify.run();
        }}
      >
        <Field id="code" label="6-digit code" hint="It works for 15 minutes." error={codeError}>
          <input
            id="code"
            className="wh-input mono code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            autoFocus
            aria-invalid={codeError ? true : undefined}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
              verify.clearError();
            }}
          />
        </Field>
        {otherError && (
          <div className="wh-help is-bad" role="alert">
            <Icon name="alert-circle" />
            <span>{otherError}</span>
          </div>
        )}
        {resent && !resend.error && wait > 0 && (
          <div className="wh-help is-ok" role="status">
            <Icon name="check-circle" />
            <span>New code sent. The old one no longer works.</span>
          </div>
        )}
        <button
          className="wh-btn is-primary"
          type="submit"
          disabled={code.length !== 6 || verify.pending}
        >
          {verify.pending ? "Checking…" : "Confirm email"}
        </button>
        <button
          className="wh-btn is-ghost"
          type="button"
          disabled={wait > 0 || resend.pending}
          onClick={() => void resend.run()}
        >
          <Icon name="rotate" />
          {resend.pending
            ? "Sending…"
            : wait > 0
              ? `Send a new code in ${wait} s`
              : "Send a new code"}
        </button>
      </form>
      <p className="fine" style={{ textAlign: "center" }}>
        Nothing arriving? Check spam, or that the address above is right.
      </p>
    </AuthPage>
  );
}
