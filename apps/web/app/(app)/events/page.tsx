"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { FilterSelect, Pager, TableSkeleton, usePager } from "@/components/list";
import { Empty, ErrorAlert, PageHead, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, shortUrl } from "@/lib/format";
import { useAction, useApi } from "@/lib/hooks";
import type { Endpoint, EventRow, Page } from "@/lib/types";

const COLUMNS = ["Event", "Type", "Created", "Endpoint", "Attempts", "Delivery"];
const TYPES = ["payment.received", "payment.rejected", "test.ping", "system.network_reset"];
const STATUSES = ["DELIVERED", "RETRYING", "FAILED", "PENDING", "CANCELLED"];
const PAGE_SIZE = 25;

/** yyyy-MM-ddTHH:mm in local time, the format a datetime-local input uses. */
function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Replay({ endpoints, onClose, onDone }: { endpoints: Endpoint[]; onClose: () => void; onDone: () => void }) {
  const [since, setSince] = useState(() => localInput(new Date(Date.now() - 24 * 3_600_000)));
  const [endpointId, setEndpointId] = useState(endpoints[0]?.id ?? "");
  const [requeued, setRequeued] = useState<number>();
  const replay = useAction(async () => {
    const result = await api<{ requeued: number }>(`/v1/endpoints/${endpointId}/replay`, { method: "POST", body: { since: new Date(since).toISOString() } });
    setRequeued(result.requeued);
    onDone();
  });
  const endpoint = endpoints.find((e) => e.id === endpointId);

  return (
    <section className="wh-panel" aria-label="Replay failed events">
      <header>
        <span className="h">
          <Icon name="rotate" />
          Replay failed events
        </span>
        <button className="wh-btn is-icon is-ghost" type="button" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="panel-body">
        <div className="form-grid">
          <div className="wh-field">
            <label htmlFor="since">Failed since</label>
            <input id="since" className="wh-input mono" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div className="wh-field">
            <label htmlFor="replay-endpoint">Endpoint</label>
            <FilterSelect label="Endpoint" value={endpointId} onChange={setEndpointId} options={endpoints.map((e) => ({ value: e.id, label: shortUrl(e.url) }))} />
          </div>
        </div>
        <div className="result">
          <Icon name="info" size={14} />
          <span>
            {requeued === undefined ? (
              <>
                Failed deliveries created since then are sent again, oldest first, up to 1,000, with fresh signatures. The event IDs don't change, so dedupe on <span style={{ color: "var(--ink)" }}>id</span>.
              </>
            ) : requeued === 0 ? (
              "No failed deliveries since then for this endpoint."
            ) : (
              <>
                <strong style={{ color: "var(--ink)" }}>
                  {requeued} failed {requeued === 1 ? "delivery" : "deliveries"}
                </strong>{" "}
                queued again.
              </>
            )}
          </span>
        </div>
        {endpoint?.status === "DISABLED" && (
          <div className="wh-help is-warn">
            <Icon name="alert-triangle" />
            <span>This endpoint is disabled. Replayed deliveries wait until you re-enable it.</span>
          </div>
        )}
        {replay.error && <ErrorAlert error={replay.error} title="Couldn't replay." />}
      </div>
      <div className="panel-foot">
        <button className="wh-btn is-ghost" type="button" onClick={onClose}>
          {requeued === undefined ? "Cancel" : "Close"}
        </button>
        <button className="wh-btn is-primary" type="button" disabled={!endpointId || !since || replay.pending} onClick={() => void replay.run()}>
          <Icon name="rotate" />
          {replay.pending ? "Replaying…" : "Replay failed events"}
        </button>
      </div>
    </section>
  );
}

export default function EventsPage() {
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (type) params.set("type", type);
  if (status) params.set("deliveryStatus", status);
  if (endpointId) params.set("endpointId", endpointId);
  const filterKey = params.toString();
  const pager = usePager(filterKey);
  params.set("limit", String(PAGE_SIZE));
  if (pager.cursor) params.set("cursor", pager.cursor);

  const events = useApi<Page<EventRow>>(`/v1/events?${params.toString()}`, pager.page === 1 ? ["payment.detected", "delivery.updated"] : ["delivery.updated"]);
  const rows = events.data?.data ?? [];
  const allEndpoints = endpoints.data?.data ?? [];
  const host = (event: EventRow) => {
    const endpoint = allEndpoints.find((e) => e.id === event.deliveries[0]?.endpointId);
    return endpoint ? (shortUrl(endpoint.url).split("/")[0] ?? "") : "deleted endpoint";
  };
  const href = (event: EventRow) => `/events/view?id=${encodeURIComponent(event.id)}`;

  return (
    <>
      <PageHead
        title="Webhook events"
        sub="Every webhook we've sent, with its delivery status."
        actions={
          <button className="wh-btn" type="button" disabled={allEndpoints.length === 0} onClick={() => setReplaying(true)}>
            <Icon name="rotate" />
            Replay failed events since…
          </button>
        }
      />
      {replaying && <Replay endpoints={allEndpoints} onClose={() => setReplaying(false)} onDone={events.reload} />}
      <div className="filters">
        <div className="search">
          <label className="sr-only" htmlFor="eq">
            Search events
          </label>
          <Icon name="search" />
          <input id="eq" className="wh-input" placeholder="Search event ID or payment ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <FilterSelect label="Type" value={type} onChange={setType} options={[{ value: "", label: "All" }, ...TYPES.map((t) => ({ value: t, label: t }))]} />
        <FilterSelect label="Delivery" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, ...STATUSES.map((s) => ({ value: s, label: s.toLowerCase() }))]} />
        <FilterSelect label="Endpoint" value={endpointId} onChange={setEndpointId} options={[{ value: "", label: "All" }, ...allEndpoints.map((e) => ({ value: e.id, label: shortUrl(e.url) }))]} />
      </div>
      {events.error && !events.data ? (
        <ErrorAlert error={events.error} title="Couldn't load webhook events." onRetry={events.reload} />
      ) : !events.data ? (
        <TableSkeleton columns={COLUMNS} widths={[150, 110, 96, 120, 24, 72]} />
      ) : rows.length === 0 && pager.page === 1 ? (
        filterKey ? (
          <Empty icon="search" title="No events match">
            Nothing fits these filters. Clear the search or pick another type or delivery state.
          </Empty>
        ) : (
          <Empty
            icon="send"
            title="No webhook events yet"
            actions={
              <Link className="wh-btn is-primary" href="/endpoints">
                <Icon name="send" />
                Send a test from Endpoints
              </Link>
            }
          >
            Events appear when a watched wallet gets paid, or when you send a test. Send one now to check your endpoint is wired up.
          </Empty>
        )
      ) : (
        <>
          <div className="wh-resp">
            <table className="wh-table">
              <caption className="sr-only">Webhook events</caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th scope="col" key={c} className={c === "Attempts" ? "num" : undefined}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => {
                  const delivery = event.deliveries[0];
                  return (
                    <tr key={event.id}>
                      <td>
                        <Link className="rowlink" href={href(event)}>
                          {event.id}
                        </Link>
                      </td>
                      <td>
                        <span className="code-chip">{event.type}</span>
                      </td>
                      <td className="muted">{dateTime(event.createdAt)}</td>
                      <td>{host(event)}</td>
                      <td className="num">{delivery?.attemptCount ?? 0}</td>
                      <td style={{ paddingTop: 8, paddingBottom: 8 }}>{delivery && <StatusBadge status={delivery.status} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="wh-stack">
              {rows.map((event) => {
                const delivery = event.deliveries[0];
                return (
                  <Link href={href(event)} key={event.id}>
                    <div className="top">
                      <span className="code-chip">{event.type}</span>
                      {delivery && <StatusBadge status={delivery.status} />}
                    </div>
                    <dl>
                      <dt>Event</dt>
                      <dd>{event.id}</dd>
                      <dt>Created</dt>
                      <dd>{dateTime(event.createdAt)}</dd>
                      <dt>Endpoint</dt>
                      <dd>{host(event)}</dd>
                      <dt>Attempts</dt>
                      <dd>{delivery?.attemptCount ?? 0}</dd>
                    </dl>
                  </Link>
                );
              })}
            </div>
          </div>
          <Pager page={pager.page} count={rows.length} noun="event" nextCursor={events.data.nextCursor} onOlder={pager.older} onNewer={pager.newer} />
        </>
      )}
    </>
  );
}
