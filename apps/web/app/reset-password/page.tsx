"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AuthPage, issueText } from "@/components/auth";
import { Icon } from "@/components/icons";
import { Field } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const reset = useAction(() =>
    api("/auth/reset", { method: "POST", body: { token, newPassword: password } }),
  );

  const tokenError = !token
    ? issueText("invalid_or_expired_token")
    : issueText(reset.error?.issueFor("token"));
  const passwordError = issueText(reset.error?.issueFor("newPassword"));

  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={async (event: FormEvent) => {
        event.preventDefault();
        if ((await reset.run()) !== undefined) router.replace("/login");
      }}
    >
      <Field
        id="password"
        label="New password"
        hint="At least 10 characters. A passphrase works well."
        error={passwordError}
      >
        <input
          id="password"
          className="wh-input"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={passwordError ? true : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {tokenError && (
        <div className="wh-help is-bad" role="alert">
          <Icon name="alert-circle" />
          <span>{tokenError}</span>
        </div>
      )}
      <button
        className="wh-btn is-primary"
        type="submit"
        disabled={reset.pending || !password || !token}
      >
        {reset.pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthPage
      title="Choose a new password"
      hint="Setting a new password signs you out everywhere else."
      footer={<Link href="/login">Back to log in</Link>}
    >
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthPage>
  );
}
