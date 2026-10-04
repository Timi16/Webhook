import type { ReactNode } from "react";
import { TestnetBanner } from "./banner";
import { Logo } from "./icons";

/** The card used by the not-found, error and network-status screens. */
export function SystemPage({
  code,
  title,
  children,
}: {
  code: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <TestnetBanner />
      <div className="sys">
        <div className="sys-card">
          <span className="brand" style={{ padding: 0 }}>
            <Logo />
            <span className="wordmark">webhook</span>
            <span className="net">testnet</span>
          </span>
          <div className="sys-code">{code}</div>
          <h1 className="display">{title}</h1>
          {children}
        </div>
      </div>
    </>
  );
}
