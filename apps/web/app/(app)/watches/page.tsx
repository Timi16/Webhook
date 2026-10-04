"use client";

import Link from "next/link";
import { Icon } from "@/components/icons";
import { TrustStatus } from "@/components/trust";
import { Empty, ErrorAlert, PageHead, Skeleton, StatusBadge } from "@/components/ui";
import { useAccounts } from "@/lib/accounts";
import { shortAddress, shortUrl } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { amountRuleShort, assetCodes, memoRuleShort } from "@/lib/rules";
import type { Endpoint, Watch } from "@/lib/types";

const COLUMNS = ["Watch", "Asset", "Amount rule", "Memo rule", "Endpoint", "Trustline", "Status"];

export default function WatchesPage() {
  const watches = useApi<{ data: Watch[] }>("/v1/watches");
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const rows = watches.data?.data ?? [];
  const accounts = useAccounts(rows.map((w) => w.walletAddress));
  const endpointHost = (id: string) => {
    const endpoint = endpoints.data?.data.find((e) => e.id === id);
    return endpoint ? (shortUrl(endpoint.url).split("/")[0] ?? "") : "—";
  };
  const href = (watch: Watch) => `/watches/view?id=${watch.id}`;

  return (
    <>
      <PageHead
        title="Watches"
        sub="Wallets we monitor and the rules each payment must pass."
        actions={
          <Link className="wh-btn is-primary" href="/watches/new">
            <Icon name="plus" />
            Create watch
          </Link>
        }
      />
      {watches.error && !watches.data ? (
        <ErrorAlert error={watches.error} title="Couldn't load watches." onRetry={watches.reload} />
      ) : !watches.data ? (
        <div className="wh-resp">
          <table className="wh-table" aria-busy="true">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th scope="col" key={c}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3].map((row) => (
                <tr key={row}>
                  {[96, 64, 120, 88, 110, 48, 72].map((width, i) => (
                    <td key={i}>
                      <Skeleton width={width} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows.length === 0 ? (
        <Empty
          icon="eye"
          title="Watch your first wallet"
          actions={
            <Link className="wh-btn is-primary" href="/watches/new">
              <Icon name="plus" />
              Create watch
            </Link>
          }
        >
          A watch tells us which wallet to monitor, what a valid payment looks like, and where to
          send the webhook.
        </Empty>
      ) : (
        <div className="wh-resp">
          <table className="wh-table">
            <caption className="sr-only">Watches</caption>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th scope="col" key={c}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((watch) => (
                <tr key={watch.id}>
                  <td>
                    <Link
                      className="rowlink"
                      href={href(watch)}
                      style={{ fontFamily: "var(--font-sans)" }}
                    >
                      {watch.label ?? "Untitled watch"}
                    </Link>
                    <div className="wh-reason">{shortAddress(watch.walletAddress)}</div>
                  </td>
                  <td>{assetCodes(watch)}</td>
                  <td>{amountRuleShort(watch.amountRule)}</td>
                  <td>{memoRuleShort(watch.memoRule)}</td>
                  <td>{endpointHost(watch.endpointId)}</td>
                  <td>
                    <TrustStatus
                      account={accounts.get(watch.walletAddress)}
                      assets={watch.assets}
                      compact
                    />
                  </td>
                  <td style={{ paddingTop: 8, paddingBottom: 8 }}>
                    <StatusBadge status={watch.active ? "ACTIVE" : "PAUSED"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="wh-stack">
            {rows.map((watch) => (
              <Link href={href(watch)} key={watch.id}>
                <div className="top">
                  <span style={{ fontFamily: "var(--font-sans)", fontWeight: 500 }}>
                    {watch.label ?? "Untitled watch"}
                  </span>
                  <StatusBadge status={watch.active ? "ACTIVE" : "PAUSED"} />
                </div>
                <dl>
                  <dt>Wallet</dt>
                  <dd>{shortAddress(watch.walletAddress)}</dd>
                  <dt>Asset</dt>
                  <dd>{assetCodes(watch)}</dd>
                  <dt>Amount</dt>
                  <dd>{amountRuleShort(watch.amountRule)}</dd>
                  <dt>Memo</dt>
                  <dd>{memoRuleShort(watch.memoRule)}</dd>
                  <dt>Endpoint</dt>
                  <dd>{endpointHost(watch.endpointId)}</dd>
                </dl>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
