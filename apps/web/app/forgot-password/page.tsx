"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthPage } from "@/components/auth";
import { Icon } from "@/components/icons";
import { Field } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string>();
  const send = useAction(async () => {
    await api("/auth/forgot", { method: "POST", body: { email } });
    setSentTo(email);
  });

  return (
    <AuthPage
      title="Reset your password"
      hint="Enter your account email and we'll send a link that works for 1 hour."
      footer={<Link href="/login">Back to log in</Link>}
    >
      <form
        className="auth-form"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void send.run();
        }}
      >
        <Field id="email" label="Email">
          <input
            id="email"
            className="wh-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <button className="wh-btn is-primary" type="submit" disabled={send.pending || !email}>
          {send.pending ? "Sending…" : "Send reset link"}
        </button>
        {sentTo && (
          <div className="wh-help is-ok" role="status">
            <Icon name="check-circle" />
            <span>
              If an account exists for {sentTo}, a reset link is on its way. Check spam if it's not
              there in 2 minutes.
            </span>
          </div>
        )}
        {send.error && (
          <div className="wh-help is-bad" role="alert">
            <Icon name="alert-circle" />
            <span>
              {send.error.issueFor("email") ? "Enter a valid email address." : send.error.message}
            </span>
          </div>
        )}
      </form>
    </AuthPage>
  );
}
