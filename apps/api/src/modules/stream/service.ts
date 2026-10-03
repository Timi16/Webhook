import type { Response } from "express";
import { CHANNELS, type Channel, type PgListener } from "../../db/notify.js";

const PING_INTERVAL_MS = 25_000;
const MAX_STREAMS_PER_DEVELOPER = 5;

const EVENT_NAMES: Partial<Record<Channel, string>> = {
  [CHANNELS.payments]: "payment.detected",
  [CHANNELS.deliveriesUpdated]: "delivery.updated",
  [CHANNELS.endpointsUpdated]: "endpoint.updated",
  [CHANNELS.notices]: "system.notice",
};

/** The API process LISTENs once and fans notifications out to connected clients by developerId. */
export class StreamHub {
  private readonly clients = new Map<string, Set<Response>>();
  private readonly ping: NodeJS.Timeout;

  constructor() {
    // A comment line every 25 s keeps proxies from closing idle streams.
    this.ping = setInterval(() => {
      for (const set of this.clients.values()) for (const res of set) res.write(": ping\n\n");
    }, PING_INTERVAL_MS);
    this.ping.unref();
  }

  attach(listener: PgListener): void {
    for (const channel of Object.keys(EVENT_NAMES) as Channel[]) {
      listener.on(channel, (payload) => this.publish(channel, payload));
    }
  }

  /** Sends one notification to the developer it belongs to, and to nobody else. */
  publish(channel: Channel, payload: Record<string, unknown>): void {
    const name = EVENT_NAMES[channel];
    const { developerId, ...data } = payload;
    if (!name || typeof developerId !== "string") return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients.get(developerId) ?? []) res.write(frame);
  }

  add(developerId: string, res: Response): void {
    const set = this.clients.get(developerId) ?? new Set<Response>();
    // A few tabs are fine; beyond that the oldest stream is closed (the browser reconnects if it is still open).
    while (set.size >= MAX_STREAMS_PER_DEVELOPER) {
      const oldest = set.values().next().value;
      if (!oldest) break;
      set.delete(oldest);
      oldest.end();
    }
    set.add(res);
    this.clients.set(developerId, set);
    res.on("close", () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(developerId);
    });
  }

  /** Ends every stream (graceful shutdown). */
  closeAll(): void {
    clearInterval(this.ping);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }
}
