"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { initials } from "@/lib/format";
import { TestnetBanner } from "./banner";
import { Icon, Logo, type IconName } from "./icons";
import { SessionGate, useSession } from "./session";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/overview", label: "Overview", icon: "layout" },
  { href: "/watches", label: "Watches", icon: "eye" },
  { href: "/endpoints", label: "Endpoints", icon: "webhook" },
  { href: "/payments", label: "Payments", icon: "arrow-down-left" },
  { href: "/events", label: "Webhook events", icon: "send" },
  { href: "/api-keys", label: "API keys", icon: "key" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

function Nav() {
  const pathname = usePathname();
  const { developer } = useSession();
  const displayName = developer.name ?? developer.email.split("@")[0] ?? developer.email;
  return (
    <nav className="nav" aria-label="Main">
      <Link className="brand" href="/overview" aria-label="Webhook home">
        <Logo />
        <span className="wordmark">webhook</span>
        <span className="net">testnet</span>
      </Link>
      <ul className="nav-list">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                className={active ? "nav-item is-active" : "nav-item"}
                href={item.href}
                aria-current={active ? "page" : undefined}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="nav-foot">
        <span className="avatar" aria-hidden="true">
          {initials(displayName)}
        </span>
        <span className="who">
          <span>{displayName}</span>
          <span className="muted">{developer.workspace ?? developer.email}</span>
        </span>
      </div>
    </nav>
  );
}

/** The signed-in layout: testnet banner, navigation rail and the page. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <TestnetBanner />
      <SessionGate>
        <div className="shell">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </SessionGate>
    </>
  );
}
