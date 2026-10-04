import type { OverviewRepo } from "./repo.js";

const WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export function createOverviewService(repo: OverviewRepo, now: () => Date = () => new Date()) {
  return {
    async get(developerId: string) {
      const at = now();
      const data = await repo.summary(developerId, WINDOW_HOURS, at);

      const matches = (outcome: string) =>
        data.outcomes.find((o) => o.outcome === outcome)?.matches ?? 0;
      const deliveries = (status: string) =>
        data.deliveries.find((d) => d.status === status)?.count ?? 0;
      const watches = (active: boolean) =>
        data.watches.find((w) => w.active === active)?._count._all ?? 0;
      const round = (value: number | null | undefined) =>
        value === null || value === undefined ? null : Math.round(value);

      // One bucket per clock hour, oldest first, ending with the current hour.
      const currentHour = Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
      const hourly = Array.from({ length: WINDOW_HOURS }, (_, index) => {
        const start = currentHour - (WINDOW_HOURS - 1 - index) * HOUR_MS;
        const count = (outcome: string) =>
          data.hourly.find((h) => h.hour.getTime() === start && h.outcome === outcome)?.count ?? 0;
        return {
          hour: new Date(start).toISOString(),
          verified: count("VERIFIED"),
          rejected: count("REJECTED"),
        };
      });

      return {
        windowHours: WINDOW_HOURS,
        payments: {
          // A payment evaluated by two watches is one payment but two results.
          total: data.outcomes.reduce((sum, o) => sum + o.payments, 0),
          verified: matches("VERIFIED"),
          rejected: matches("REJECTED"),
          previousTotal: data.previous[0]?.payments ?? 0,
        },
        deliveries: {
          delivered: deliveries("DELIVERED"),
          retrying: deliveries("RETRYING"),
          failed: deliveries("FAILED"),
          pending: deliveries("PENDING") + deliveries("SENDING"),
          medianMs: round(data.durations[0]?.median),
          p95Ms: round(data.durations[0]?.p95),
        },
        watches: { active: watches(true), paused: watches(false) },
        hourly,
      };
    },
  };
}

export type OverviewService = ReturnType<typeof createOverviewService>;
