"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthPage } from "@/components/auth";
import { Icon } from "@/components/icons";
import { Field, PasswordInput } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useAction(() => api("/auth/login", { method: "POST", body: { email, password } }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await login.run()) !== undefined) router.replace("/overview");
  }

  return (
    <AuthPage
      title="Log in"
      hint="Watch wallets, verify payments, deliver signed webhooks."
      footer={
        <>
          New here? <Link href="/signup">Create an account</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field id="email" label="Email">
          <input
            id="email"
            className="wh-input"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          id="password"
          label="Password"
          labelAside={<Link href="/forgot-password">Forgot password?</Link>}
        >
          <PasswordInput
            id="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {login.error && (
          <div className="wh-help is-bad" role="alert">
            <Icon name="alert-circle" />
            <span>
              {login.error.status === 401 || login.error.status === 400
                ? "That email and password don't match an account."
                : login.error.message}
            </span>
          </div>
        )}
        <button
          className="wh-btn is-primary"
          type="submit"
          disabled={login.pending || !email || !password}
        >
          {login.pending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthPage>
  );
}
