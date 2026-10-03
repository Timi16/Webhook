import type { Prisma, PrismaClient } from "@prisma/client";
import pg from "pg";
import type { Logger } from "../lib/logger.js";

export const CHANNELS = {
  watchesChanged: "watches_changed",
  watchBackfill: "watch_backfill",
  deliveries: "deliveries",
  payments: "payments",
  deliveriesUpdated: "deliveries_updated",
  endpointsUpdated: "endpoints_updated",
  notices: "notices",
} as const;
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

type Db = PrismaClient | Prisma.TransactionClient;

/** Inside a transaction the notification is only delivered if (and when) it commits. */
export async function notify(
  db: Db,
  channel: Channel,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.$queryRaw`SELECT pg_notify(${channel}, ${JSON.stringify(payload)})::text`;
}

type Handler = (payload: Record<string, unknown>) => void;

const RECONNECT_DELAY_MS = 1_000;

/** One dedicated pg connection that LISTENs and reconnects by itself. */
export class PgListener {
  private client: pg.Client | undefined;
  private readonly handlers = new Map<Channel, Set<Handler>>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: Logger,
  ) {}

  /** Register handlers before start(). */
  on(channel: Channel, handler: Handler): void {
    const set = this.handlers.get(channel) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(channel, set);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on("notification", (msg) => this.dispatch(msg.channel, msg.payload));
    client.on("error", (err) => {
      this.logger.warn({ err: err.message }, "listener connection error");
      this.reconnect(client);
    });
    client.on("end", () => this.reconnect(client));
    await client.connect();
    for (const channel of this.handlers.keys()) await client.query(`LISTEN "${channel}"`);
    this.client = client;
  }

  private reconnect(dead: pg.Client): void {
    if (this.stopped || this.client !== dead) return;
    this.client = undefined;
    dead.end().catch(() => {});
    const attempt = () => {
      if (this.stopped) return;
      this.connect().catch((err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : err },
          "listener reconnect failed",
        );
        this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
      });
    };
    this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
  }

  private dispatch(channel: string, raw: string | undefined): void {
    const handlers = this.handlers.get(channel as Channel);
    if (!handlers) return;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed === "object" && parsed !== null)
        payload = parsed as Record<string, unknown>;
    } catch {
      // Notifications are only a wake-up signal; a malformed payload still wakes the handlers.
    }
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        this.logger.error({ err }, "notification handler failed");
      }
    }
  }
}
