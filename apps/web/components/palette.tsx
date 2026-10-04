"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { DOCS_URL } from "@/lib/constants";
import { shortAddress, shortUrl } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { ApiKey, Endpoint, EventRow, Page, PaymentRow, Watch } from "@/lib/types";
import { Icon, type IconName } from "./icons";

interface Item {
  group: string;
  icon: IconName;
  title: string;
  hint?: string;
  /** A dashboard path, or a full URL that opens in a new tab. */
  href: string;
  /** Extra words to match on. */
  keywords?: string;
}

const PAGES: Item[] = [
  { group: "Go to", icon: "layout", title: "Overview", href: "/overview" },
  { group: "Go to", icon: "eye", title: "Watches", href: "/watches" },
  { group: "Go to", icon: "webhook", title: "Endpoints", href: "/endpoints" },
  { group: "Go to", icon: "arrow-down-left", title: "Payments", href: "/payments" },
  { group: "Go to", icon: "send", title: "Webhook events", href: "/events" },
  { group: "Go to", icon: "key", title: "API keys", href: "/api-keys" },
  {
    group: "Go to",
    icon: "settings",
    title: "Settings",
    href: "/settings",
    keywords: "account password email theme audit log",
  },
  {
    group: "Go to",
    icon: "activity",
    title: "Network status",
    href: "/status",
    keywords: "uptime",
  },
  {
    group: "Do",
    icon: "plus",
    title: "Create a watch",
    href: "/watches/new",
    keywords: "new add wallet",
  },
  {
    group: "Do",
    icon: "list-checks",
    title: "Setup checklist",
    href: "/onboarding",
    keywords: "onboarding first",
  },
  {
    group: "Do",
    icon: "book",
    title: "Open the docs",
    href: DOCS_URL,
    keywords: "documentation api reference",
  },
];

const SEARCH_DELAY_MS = 200;

/**
 * Cmd+K (Ctrl+K): jump to any screen, watch, endpoint or key, or find a payment or webhook event
 * by its ID, transaction hash, memo or address.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<{ query: string; items: Item[] }>({ query: "", items: [] });

  const watches = useApi<{ data: Watch[] }>(open ? "/v1/watches" : null);
  const endpoints = useApi<{ data: Endpoint[] }>(open ? "/v1/endpoints" : null);
  const keys = useApi<{ data: ApiKey[] }>(open ? "/v1/api-keys" : null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    input.current?.focus();
  }, [open]);

  const q = query.trim();
  // Payments and events are searched on the server, a moment after typing stops.
  useEffect(() => {
    if (!open || q.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const encoded = encodeURIComponent(q);
      void Promise.all([
        api<Page<PaymentRow>>(`/v1/payments?q=${encoded}&limit=5`).catch(() => ({ data: [] })),
        api<Page<EventRow>>(`/v1/events?q=${encoded}&limit=5`).catch(() => ({ data: [] })),
      ]).then(([payments, events]) => {
        if (cancelled) return;
        setFound({
          query: q,
          items: [
            ...payments.data.map((p) => ({
              group: "Payments",
              icon: "arrow-down-left" as IconName,
              title: `${p.amount} ${p.asset.code} from ${shortAddress(p.from)}`,
              hint: p.memo ? `memo ${p.memo.slice(0, 24)}` : `ledger ${p.ledger}`,
              href: `/payments/view?id=${encodeURIComponent(p.id)}`,
            })),
            ...events.data.map((e) => ({
              group: "Webhook events",
              icon: "send" as IconName,
              title: e.id,
              hint: e.type,
              href: `/events/view?id=${e.id}`,
            })),
          ],
        });
      });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, q]);

  const items = useMemo(() => {
    const own: Item[] = [
      ...(watches.data?.data ?? []).map((w) => ({
        group: "Watches",
        icon: "eye" as IconName,
        title: w.label ?? shortAddress(w.walletAddress),
        hint: shortAddress(w.walletAddress),
        href: `/watches/view?id=${w.id}`,
        keywords: `${w.walletAddress} ${w.id}`,
      })),
      ...(endpoints.data?.data ?? []).map((e) => ({
        group: "Endpoints",
        icon: "webhook" as IconName,
        title: shortUrl(e.url),
        hint: e.status.toLowerCase(),
        href: "/endpoints",
        keywords: `${e.id} ${e.description ?? ""}`,
      })),
      ...(keys.data?.data ?? []).map((k) => ({
        group: "API keys",
        icon: "key" as IconName,
        title: k.name,
        hint: `${k.prefix}…`,
        href: `/api-keys/view?id=${k.id}`,
        keywords: `${k.prefix} ${k.id} ${k.note ?? ""}`,
      })),
    ];
    const needle = q.toLowerCase();
    const matches = (item: Item) =>
      `${item.title} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(needle);
    if (!needle) return PAGES;
    return [
      ...PAGES.filter(matches),
      ...own.filter(matches),
      ...(found.query === q ? found.items : []),
    ];
  }, [q, watches.data, endpoints.data, keys.data, found]);

  if (!open) return null;

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.href.startsWith("http")) window.open(item.href, "_blank", "noopener");
    else router.push(item.href);
  };
  const active = Math.min(selected, Math.max(0, items.length - 1));

  return (
    <div
      className="overlay palette-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            placeholder="Search pages, watches, tx hashes, event IDs…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected(Math.min(active + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected(Math.max(active - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(items[active]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox">
          {items.length === 0 && (
            <li className="palette-empty">
              {q.length < 3
                ? "Keep typing: payments and events are searched from 3 characters."
                : `Nothing matches “${q}”. Payments match by tx hash, memo or address; events by their ID.`}
            </li>
          )}
          {items.map((item, i) => (
            <li key={`${item.group}-${item.href}-${item.title}`} role="presentation">
              {(i === 0 || items[i - 1]?.group !== item.group) && (
                <div className="palette-group">{item.group}</div>
              )}
              <button
                type="button"
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "palette-item is-active" : "palette-item"}
                onPointerMove={() => setSelected(i)}
                onClick={() => go(item)}
              >
                <Icon name={item.icon} />
                <span className="t">{item.title}</span>
                {item.hint && <span className="h">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
