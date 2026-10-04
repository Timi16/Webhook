"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export interface Account {
  address: string;
  /** null: Horizon could not be reached, so we don't know. */
  exists: boolean | null;
  assets: { code: string; issuer: string | null }[];
}

// Wallets are looked up once per page view; several rows often share one wallet.
const cache = new Map<string, Promise<Account>>();

function lookup(address: string): Promise<Account> {
  let pending = cache.get(address);
  if (!pending) {
    pending = api<Account>(`/v1/accounts/${address}`);
    cache.set(address, pending);
    pending.catch(() => cache.delete(address));
  }
  return pending;
}

/** What testnet knows about each wallet, keyed by address. Missing until it has loaded. */
export function useAccounts(addresses: string[]): Map<string, Account> {
  const [accounts, setAccounts] = useState(new Map<string, Account>());
  const key = [...new Set(addresses)].sort().join(",");
  useEffect(() => {
    let cancelled = false;
    for (const address of key ? key.split(",") : []) {
      lookup(address).then(
        (account) => {
          if (!cancelled) setAccounts((previous) => new Map(previous).set(address, account));
        },
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key]);
  return accounts;
}

export type Trust = "ok" | "missing" | "no-account" | "unknown";

/** Can this wallet receive every asset the watch accepts? */
export function trustFor(
  account: Account | undefined,
  assets: { code: string; issuer: string | null }[],
): { state: Trust; missing: string[] } {
  if (!account || account.exists === null) return { state: "unknown", missing: [] };
  if (!account.exists) return { state: "no-account", missing: [] };
  const missing = assets
    .filter((a) => !account.assets.some((held) => held.code === a.code && held.issuer === a.issuer))
    .map((a) => a.code);
  return { state: missing.length > 0 ? "missing" : "ok", missing };
}
