"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/session";
import { USDC, XLM } from "./constants";
import { useApi } from "./hooks";
import type { Endpoint, Page, PaymentRow, Watch } from "./types";

const STORAGE_KEY = "webhook-setup";

export type SetupAsset = "USDC" | "XLM" | "Custom";

/** Step 1's answers. A watch needs an endpoint, so they wait here until step 2 creates one. */
export interface WalletDraft {
  label: string;
  address: string;
  asset: SetupAsset;
  customCode: string;
  customIssuer: string;
  /** Empty means any amount. */
  minAmount: string;
}
export interface TestResult {
  endpointId: string;
  eventId: string;
  statusCode: number;
  durationMs: number;
}
export interface SetupDraft {
  wallet?: WalletDraft | undefined;
  test?: TestResult | undefined;
}

function readDraft(developerId: string): SetupDraft {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
      developerId?: string;
      draft?: SetupDraft;
    } | null;
    // A draft left behind by another account on this browser is not ours.
    return stored?.developerId === developerId && stored.draft ? stored.draft : {};
  } catch {
    return {};
  }
}

function writeDraft(developerId: string, draft: SetupDraft) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ developerId, draft }));
  } catch {
    // storage can be blocked; the draft then lasts for this page only
  }
}

export function draftAsset(wallet: WalletDraft) {
  if (wallet.asset === "XLM") return XLM;
  if (wallet.asset === "USDC") return USDC;
  return { code: wallet.customCode.trim(), issuer: wallet.customIssuer.trim() };
}

/** The request that turns step 1's answers into a watch. */
export function watchBody(wallet: WalletDraft, endpointId: string, notifyRejected: boolean) {
  return {
    label: wallet.label.trim() || null,
    walletAddress: wallet.address,
    endpointId,
    assets: [draftAsset(wallet)],
    amountRule: wallet.minAmount ? { kind: "min", amount: wallet.minAmount } : { kind: "any" },
    memoRule: { kind: "any" },
    senderAllowlist: [],
    eventTypes: notifyRejected ? ["payment.received", "payment.rejected"] : ["payment.received"],
  };
}

/** Where the developer is in the setup flow, read from their real watches, endpoints and payments. */
export function useSetup() {
  const { developer } = useSession();
  const [draft, setDraft] = useState<SetupDraft>();
  useEffect(() => setDraft(readDraft(developer.id)), [developer.id]);

  const watches = useApi<{ data: Watch[] }>("/v1/watches");
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints", ["endpoint.updated"]);
  const watch = watches.data?.data[0];
  const endpoint =
    endpoints.data?.data.find((e) => e.id === watch?.endpointId) ?? endpoints.data?.data[0];
  const payments = useApi<Page<PaymentRow>>(
    watch ? `/v1/payments?watchId=${watch.id}&limit=1` : null,
    ["payment.detected"],
  );
  const payment = payments.data?.data[0];
  const test = draft?.test && draft.test.endpointId === endpoint?.id ? draft.test : undefined;

  const done = {
    wallet: watch !== undefined || draft?.wallet !== undefined,
    endpoint: endpoint !== undefined && watch !== undefined,
    test: test !== undefined,
    payment: payment !== undefined,
  };
  return {
    ready: draft !== undefined && watches.data !== undefined && endpoints.data !== undefined,
    error: watches.error ?? endpoints.error,
    reload: () => {
      watches.reload();
      endpoints.reload();
    },
    draft: draft ?? {},
    saveDraft: (patch: SetupDraft) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      writeDraft(developer.id, next);
    },
    watch,
    endpoint,
    payment,
    test,
    done,
    doneCount: Object.values(done).filter(Boolean).length,
  };
}

export type Setup = ReturnType<typeof useSetup>;
