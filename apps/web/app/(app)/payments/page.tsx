"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { FilterSelect, Pager, TableSkeleton, usePager } from "@/components/list";
import { Amount, CopyButton, Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, shortAddress } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { Page, PaymentRow, Watch } from "@/lib/types";

const COLUMNS = ["Date", "Wallet", "From", "Amount", "Memo", "Status"];
const PAGE_SIZE = 25;
const RANGES = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "all", label: "All time", hours: 0 },
] as const;
type Range = (typeof RANGES)[number]["value"];

const csvCell = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

function Payments() {
  const initialWatch = useSearchParams().get("watchId") ?? "";
  const watches = useApi<{ data: Watch[] }>("/v1/watches");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [outcome, setOutcome] = useState<"" | "VERIFIED" | "REJECTED">("");
  const [watchId, setWatchId] = useState(initialWatch);
  const [asset, setAsset] = useState("");
  const [range, setRange] = useState<Range>(initialWatch ? "all" : "24h");

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const hours = RANGES.find((r) => r.value === range)?.hours ?? 0;
  // The start of the window is fixed per filter change, so paging stays stable.
  const [since, setSince] = useState<string>();
  useEffect(
    () => setSince(hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : undefined),
    [hours],
  );

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (outcome) params.set("outcome", outcome);
  if (watchId) params.set("watchId", watchId);
  if (asset) params.set("asset", asset);
  if (since) params.set("from", since);
  const filterKey = params.toString();
  const pager = usePager(filterKey);
  params.set("limit", String(PAGE_SIZE));
  if (pager.cursor) params.set("cursor", pager.cursor);

  const payments = useApi<Page<PaymentRow>>(
    `/v1/payments?${params.toString()}`,
    pager.page === 1 ? ["payment.detected"] : [],
  );
  const rows = payments.data?.data ?? [];
  const allWatches = watches.data?.data ?? [];
  const watchOf = (p: PaymentRow) =>
    allWatches.find(
      (w) => w.id === (p.matches.find((m) => m.watchId === watchId) ?? p.matches[0])?.watchId,
    );
  const matchOf = (p: PaymentRow) => p.matches.find((m) => m.watchId === watchId) ?? p.matches[0];
  const assets = [...new Set(allWatches.flatMap((w) => w.assets.map((a) => a.code)))];
  const filtered = Boolean(q || outcome || watchId || asset);
  const href = (p: PaymentRow) => `/payments/view?id=${encodeURIComponent(p.id)}`;

  const exportCsv = useAction(async () => {
    const lines = [
      [
        "date",
        "payment_id",
        "tx_hash",
        "ledger",
        "wallet",
        "from",
        "amount",
        "asset",
        "issuer",
        "memo",
        "memo_type",
        "outcome",
        "reasons",
      ].join(","),
    ];
    const query = new URLSearchParams(filterKey);
    query.set("limit", "100");
    // Up to 5,000 rows: enough for an export, small enough for a browser.
    for (let page = 0, cursor: string | null = null; page < 50; page++) {
      if (cursor) query.set("cursor", cursor);
      const batch: Page<PaymentRow> = await api<Page<PaymentRow>>(
        `/v1/payments?${query.toString()}`,
      );
      for (const p of batch.data) {
        const match = p.matches[0];
        lines.push(
          [
            p.ledgerClosedAt,
            p.id,
            p.txHash,
            String(p.ledger),
            p.to,
            p.from,
            p.amount,
            p.asset.code,
            p.asset.issuer ?? "",
            p.memo ?? "",
            p.memoType,
            match?.outcome ?? "",
            match?.reasons.join(" ") ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
      cursor = batch.nextCursor;
      if (!cursor) break;
    }
    const url = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  const firstWallet = allWatches[0]?.walletAddress;

  return (
    <>
      <PageHead
        title="Payments"
        sub="Every payment to a watched wallet, checked against its rules."
        actions={
          <button
            className="wh-btn"
            type="button"
            disabled={exportCsv.pending || rows.length === 0}
            onClick={() => void exportCsv.run()}
          >
            <Icon name="download" />
            {exportCsv.pending ? "Exporting…" : "Export CSV"}
          </button>
        }
      />
      <div className="filters">
        <div className="search">
          <label className="sr-only" htmlFor="q">
            Search payments
          </label>
          <Icon name="search" />
          <input
            id="q"
            className="wh-input"
            placeholder="Search tx hash, memo or address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <FilterSelect
          label="Status"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "", label: "All" },
            { value: "VERIFIED", label: "Verified" },
            { value: "REJECTED", label: "Rejected" },
          ]}
        />
        <FilterSelect
          label="Wallet"
          value={watchId}
          onChange={setWatchId}
          options={[
            { value: "", label: "All" },
            ...allWatches.map((w) => ({
              value: w.id,
              label: w.label ?? shortAddress(w.walletAddress),
            })),
          ]}
        />
        <FilterSelect
          label="Asset"
          value={asset}
          onChange={setAsset}
          options={[
            { value: "", label: "All" },
            ...assets.map((code) => ({ value: code, label: code })),
          ]}
        />
        <FilterSelect
          label="Period"
          icon
          value={range}
          onChange={setRange}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </div>
      {exportCsv.error && <ErrorAlert error={exportCsv.error} title="The export didn't finish." />}
      {payments.error && !payments.data ? (
        <ErrorAlert
          error={payments.error}
          title="Couldn't load payments."
          onRetry={payments.reload}
        />
      ) : !payments.data ? (
        <TableSkeleton columns={COLUMNS} widths={[96, 120, 88, 110, 64, 72]} />
      ) : rows.length === 0 && pager.page === 1 ? (
        filtered || range !== "all" ? (
          <Empty icon="search" title="No payments match">
            Nothing fits these filters in this period. Widen the period or clear the search.
          </Empty>
        ) : (
          <Empty
            icon="inbox"
            title="No payments yet"
            actions={
              <>
                {firstWallet ? (
                  <span className="wh-row">
                    <span className="mono">{shortAddress(firstWallet)}</span>
                    <CopyButton value={firstWallet} label="Copy wallet address" />
                  </span>
                ) : (
                  <Link className="wh-btn is-primary" href="/watches/new">
                    <Icon name="plus" />
                    Create watch
                  </Link>
                )}
              </>
            }
          >
            {firstWallet
              ? "Send a testnet payment to your watched wallet. It shows up here within a few seconds of the ledger closing."
              : "Watch a wallet first. Payments to it show up here within a few seconds of the ledger closing."}
          </Empty>
        )
      ) : (
        <>
          <div className="wh-resp">
            <table className="wh-table">
              <caption className="sr-only">Payments</caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th scope="col" key={c} className={c === "Amount" ? "num" : undefined}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const match = matchOf(p);
                  const watch = watchOf(p);
                  return (
                    <tr key={p.id}>
                      <td className="muted">{dateTime(p.ledgerClosedAt)}</td>
                      <td>
                        <Link className="rowlink" href={href(p)}>
                          {watch?.label ?? "Watch"}
                        </Link>
                        <div className="wh-reason">{shortAddress(p.to)}</div>
                      </td>
                      <td>{shortAddress(p.from)}</td>
                      <td className="num">
                        <Amount amount={p.amount} code={p.asset.code} />
                      </td>
                      <td className="cell-clip" title={p.memo ?? undefined}>
                        {p.memo ?? <span className="muted">—</span>}
                      </td>
                      <td style={{ paddingTop: 8, paddingBottom: 8 }}>
                        {match && <StatusBadge status={match.outcome} />}
                        {match && match.reasons.length > 0 && (
                          <div className="wh-reason">{match.reasons.join(", ")}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="wh-stack">
              {rows.map((p) => {
                const match = matchOf(p);
                return (
                  <Link href={href(p)} key={p.id}>
                    <div className="top">
                      <Amount amount={p.amount} code={p.asset.code} />
                      {match && <StatusBadge status={match.outcome} />}
                    </div>
                    <dl>
                      <dt>Time</dt>
                      <dd>{dateTime(p.ledgerClosedAt)}</dd>
                      <dt>Wallet</dt>
                      <dd>
                        {watchOf(p)?.label ?? "Watch"} · {shortAddress(p.to)}
                      </dd>
                      <dt>From</dt>
                      <dd>{shortAddress(p.from)}</dd>
                      <dt>Memo</dt>
                      <dd style={{ overflowWrap: "anywhere" }}>{p.memo ?? "—"}</dd>
                      {match && match.reasons.length > 0 && (
                        <>
                          <dt>Reason</dt>
                          <dd>{match.reasons.join(", ")}</dd>
                        </>
                      )}
                    </dl>
                  </Link>
                );
              })}
            </div>
          </div>
          <Pager
            page={pager.page}
            count={rows.length}
            noun="payment"
            nextCursor={payments.data.nextCursor}
            onOlder={pager.older}
            onNewer={pager.newer}
          />
        </>
      )}
    </>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense>
      <Payments />
    </Suspense>
  );
}
