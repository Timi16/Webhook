"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { Setup } from "@/lib/setup";
import { TestnetBanner } from "./banner";
import { Icon, Logo } from "./icons";
import { ErrorAlert } from "./ui";

const STEPS = [
  { key: "wallet", href: "/onboarding/wallet", title: "Add a wallet", sub: "The address we watch" },
  { key: "endpoint", href: "/onboarding/endpoint", title: "Set your endpoint", sub: "Where webhooks go" },
  { key: "test", href: "/onboarding/test", title: "Send a test", sub: "Prove it works" },
  { key: "payment", href: "/onboarding/payment", title: "Make a payment", sub: "Watch one land" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/** The frame every setup step shares: banner, top bar and the four-step rail. */
export function SetupFrame({
  setup,
  step,
  children,
}: {
  setup: Setup;
  /** Omit on the final "setup complete" screen, which has no rail. */
  step?: StepKey;
  children: ReactNode;
}) {
  const index = STEPS.findIndex((s) => s.key === step);
  return (
    <>
      <TestnetBanner />
      <header className="wz-top">
        <span className="brand">
          <Logo />
          <span className="wordmark">webhook</span>
          <span className="net">testnet</span>
        </span>
        <span className="where">{step ? `Setup · step ${index + 1} of 4` : "Setup"}</span>
        <Link className="skip" href="/overview">
          {step ? "Skip setup for now" : "Go to dashboard"}
        </Link>
      </header>
      <div className="wz">
        {step && (
          <nav className="wz-steps" aria-label="Setup steps">
            <ol>
              {STEPS.map((s, i) => {
                const current = s.key === step;
                const done = setup.done[s.key] && !current;
                return (
                  <li key={s.key} className={current ? "is-current" : done ? "is-done" : "is-todo"}>
                    <Link href={s.href} aria-current={current ? "step" : undefined}>
                      <span className="n">{done ? <Icon name="check" className="ic-b" /> : i + 1}</span>
                      <span className="t">
                        <b>{s.title}</b>
                        <span>{done ? "Done" : s.sub}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        {setup.error && !setup.ready ? (
          <ErrorAlert error={setup.error} title="Couldn't load your setup." onRetry={setup.reload} />
        ) : !setup.ready ? (
          <div aria-busy="true" style={{ minHeight: 320 }} />
        ) : (
          children
        )}
      </div>
    </>
  );
}

/** A webhook payload or response, printed one line per row like the events screen. */
export function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return (
    <pre
      className="wh-json"
      tabIndex={0}
      aria-label={label}
      style={{ maxHeight: 240, border: "2px solid var(--rule)", borderRadius: 14, background: "var(--paper)" }}
    >
      {JSON.stringify(value, null, 2)
        .split("\n")
        .map((line, i) => (
          <span className="l" key={i}>
            {line}
          </span>
        ))}
    </pre>
  );
}
