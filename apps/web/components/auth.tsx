import Link from "next/link";
import type { ReactNode } from "react";
import { TestnetBanner } from "./banner";
import { Logo } from "./icons";

/** The centred card every signed-out screen uses. */
export function AuthPage({
  title,
  hint,
  children,
  footer,
}: {
  title: string;
  hint: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <>
      <TestnetBanner />
      <div className="auth">
        <div className="auth-card">
          <div className="head">
            <Link className="brand" href="/" aria-label="Webhook home page" style={{ padding: 0 }}>
              <Logo />
              <span className="wordmark">webhook</span>
              <span className="net">testnet</span>
            </Link>
            <h1 className="display">{title}</h1>
            <p className="hint">{hint}</p>
          </div>
          {children}
          <p className="auth-alt">{footer}</p>
          <p className="fine" style={{ textAlign: "center" }}></p>
        </div>
      </div>
    </>
  );
}

/** Plain words for the validation codes the API returns on the account forms. */
const ISSUES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  password_too_short: "Use at least 10 characters.",
  password_too_common: "That password is too common. Try a passphrase.",
  incorrect_password: "That isn't your current password.",
  same_email: "That is already your email address.",
  invalid_or_expired_token: "This reset link is invalid or has expired. Request a new one.",
};

export function issueText(issue: string | undefined): string | undefined {
  return issue === undefined ? undefined : (ISSUES[issue] ?? "Check this field and try again.");
}
