"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthPage, issueText } from "@/components/auth";
import { Icon } from "@/components/icons";
import { Field } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signup = useAction(() =>
    api("/auth/signup", {
      method: "POST",
      body: { email, password, ...(name.trim() ? { name: name.trim() } : {}) },
    }),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await signup.run()) !== undefined) router.replace("/onboarding/wallet");
  }

  const emailError =
    signup.error?.code === "CONFLICT"
      ? "An account with this email already exists."
      : issueText(signup.error?.issueFor("email"));
  const passwordError = issueText(signup.error?.issueFor("password"));
  const otherError =
    signup.error && !emailError && !passwordError ? signup.error.message : undefined;

  return (
    <AuthPage
      title="Create your account"
      hint="Free on testnet. Your first webhook takes about five minutes."
      footer={
        <>
          Already have an account? <Link href="/login">Log in</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field id="name" label="Name">
          <input
            id="name"
            className="wh-input"
            autoComplete="name"
            placeholder="Tolu Adebayo"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id="email" label="Work email" error={emailError}>
          <input
            id="email"
            className="wh-input"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            aria-invalid={emailError ? true : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          id="password"
          label="Password"
          hint="At least 10 characters. A passphrase works well."
          error={passwordError}
        >
          <input
            id="password"
            className="wh-input"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="password-hint"
            aria-invalid={passwordError ? true : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {otherError && (
          <div className="wh-help is-bad" role="alert">
            <Icon name="alert-circle" />
            <span>{otherError}</span>
          </div>
        )}
        <button
          className="wh-btn is-primary"
          type="submit"
          disabled={signup.pending || !email || !password}
        >
          {signup.pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthPage>
  );
}
