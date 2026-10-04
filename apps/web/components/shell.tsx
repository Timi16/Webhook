"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { DOCS_URL } from "@/lib/constants";
import { initials } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { TestnetBanner } from "./banner";
import { Icon, Logo, type IconName } from "./icons";
import { SessionGate, useSession } from "./session";
import { useTheme, type ThemeChoice } from "./theme";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/overview", label: "Overview", icon: "layout" },
  { href: "/watches", label: "Watches", icon: "eye" },
  { href: "/endpoints", label: "Endpoints", icon: "webhook" },
  { href: "/payments", label: "Payments", icon: "arrow-down-left" },
  { href: "/events", label: "Webhook events", icon: "send" },
  { href: "/api-keys", label: "API keys", icon: "key" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** The account block at the foot of the sidebar: opens a menu with the things people reach for. */
function AccountMenu({ displayName }: { displayName: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { developer } = useSession();
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const logout = useAction(async () => {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  });

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="nav-account" ref={root}>
      {open && (
        <div className="acct-menu" role="menu" aria-label="Account">
          <div className="acct-head">
            <span>{displayName}</span>
            <span className="muted">{developer.email}</span>
          </div>
          <Link role="menuitem" className="acct-item" href="/settings">
            <Icon name="settings" />
            Account settings
          </Link>
          <Link role="menuitem" className="acct-item" href="/api-keys">
            <Icon name="key" />
            API keys
          </Link>
          <a role="menuitem" className="acct-item" href={DOCS_URL} target="_blank" rel="noopener">
            <Icon name="book" />
            Documentation
            <Icon name="external-link" size={14} className="end" />
          </a>
          <Link role="menuitem" className="acct-item" href="/status">
            <Icon name="activity" />
            Network status
          </Link>
          <div className="acct-theme" role="radiogroup" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                type="button"
                role="radio"
                key={theme.value}
                aria-checked={choice === theme.value}
                onClick={() => setChoice(theme.value)}
              >
                <Icon name={theme.icon} size={14} />
                {theme.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            className="acct-item is-danger"
            disabled={logout.pending}
            onClick={() => void logout.run()}
          >
            <Icon name="arrow-left" />
            {logout.pending ? "Logging out…" : "Log out"}
          </button>
        </div>
      )}
      <button
        type="button"
        className="nav-foot"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(displayName)}
        </span>
        <span className="who">
          <span>{displayName}</span>
          <span className="muted">{developer.workspace ?? developer.email}</span>
        </span>
        <Icon name="chevron-down" className={open ? "caret is-open" : "caret"} />
      </button>
    </div>
  );
}

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
      <ul className="nav-list nav-extra">
        <li>
          <a className="nav-item" href={DOCS_URL} target="_blank" rel="noopener">
            <Icon name="book" size={18} />
            <span>Docs</span>
            <Icon name="external-link" size={14} className="end" />
          </a>
        </li>
      </ul>
      <AccountMenu displayName={displayName} />
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
