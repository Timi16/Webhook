import {
  COMPONENT_KEYS,
  utcDay,
  type CheckResult,
  type ComponentKey,
  type StatusRepo,
} from "./repo.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_DAYS = 90;
/** Up to a minute late is normal; up to five is slow; beyond that it is not working. */
const SLOW_MS = 60_000;
const DOWN_MS = 5 * 60_000;
/** A day is a major outage when more than this share of its checks failed. */
const MAJOR_OUTAGE_SHARE = 0.05;

const COMPONENTS: Record<ComponentKey, { name: string; description: string }> = {
  api: {
    name: "API",
    description: "The REST API and the dashboard's data.",
  },
  detection: {
    name: "Payment detection",
    description: "Reading the ledger and checking payments against your rules.",
  },
  delivery: {
    name: "Webhook delivery",
    description: "Sending signed webhooks to your endpoints on time.",
  },
};

type DayState = "operational" | "degraded" | "partial_outage" | "major_outage" | "no_data";
type ComponentState = "operational" | "degraded" | "outage";

function lateness(ms: number | null): CheckResult {
  if (ms === null || ms <= SLOW_MS) return "ok";
  return ms <= DOWN_MS ? "degraded" : "down";
}

const toState = (result: CheckResult): ComponentState =>
  result === "ok" ? "operational" : result === "degraded" ? "degraded" : "outage";

/** Two decimals, and never rounded up to 100 when something failed. */
function percent(passed: number, total: number): number | null {
  if (total === 0) return null;
  return Math.floor((passed / total) * 10_000) / 100;
}

export function dayState(counts: { ok: number; degraded: number; down: number }): DayState {
  const total = counts.ok + counts.degraded + counts.down;
  if (total === 0) return "no_data";
  if (counts.down / total > MAJOR_OUTAGE_SHARE) return "major_outage";
  if (counts.down > 0) return "partial_outage";
  return counts.degraded > 0 ? "degraded" : "operational";
}

export function createStatusService(
  repo: StatusRepo,
  options: { now?: () => Date; checkApi?: () => Promise<CheckResult> } = {},
) {
  const now = options.now ?? (() => new Date());

  /** Detection and delivery, judged from how late they are right now. */
  async function liveChecks(at: Date) {
    const { cursorAgeMs, oldestDueMs } = await repo.live(at);
    return { detection: lateness(cursorAgeMs), delivery: lateness(oldestDueMs) };
  }

  return {
    /**
     * One monitoring pass, run by the worker every minute: checks each component and adds the
     * result to today's counts. The API is checked from outside itself, over HTTP.
     */
    async sample(): Promise<Record<ComponentKey, CheckResult>> {
      const at = now();
      const [api, live] = await Promise.all([
        options.checkApi ? options.checkApi() : Promise.resolve<CheckResult>("ok"),
        liveChecks(at),
      ]);
      const sample = { api, ...live };
      await repo.record(sample, at);
      if (at.getUTCHours() === 0 && at.getUTCMinutes() === 0) await repo.prune(at);
      return sample;
    },

    /** The public status page: each component now, and day by day for the last 90 days. */
    async get() {
      const at = now();
      const today = utcDay(at);
      const from = new Date(today.getTime() - (HISTORY_DAYS - 1) * DAY_MS);
      const [rows, live] = await Promise.all([repo.history(from), liveChecks(at)]);
      // This code is answering, so the API is up.
      const current: Record<ComponentKey, CheckResult> = { api: "ok", ...live };

      const components = COMPONENT_KEYS.map((key) => {
        const mine = rows.filter((row) => row.component === key);
        const days = Array.from({ length: HISTORY_DAYS }, (_, i) => {
          const day = new Date(from.getTime() + i * DAY_MS);
          const row = mine.find((r) => r.day.getTime() === day.getTime());
          const counts = row ?? { ok: 0, degraded: 0, down: 0 };
          return {
            date: day.toISOString().slice(0, 10),
            status: dayState(counts),
            uptimePercent: percent(
              counts.ok + counts.degraded,
              counts.ok + counts.degraded + counts.down,
            ),
          };
        });
        const passed = mine.reduce((sum, r) => sum + r.ok + r.degraded, 0);
        const total = mine.reduce((sum, r) => sum + r.ok + r.degraded + r.down, 0);
        return {
          key,
          ...COMPONENTS[key],
          status: toState(current[key]),
          uptimePercent: percent(passed, total),
          days,
        };
      });

      const states = components.map((c) => c.status);
      return {
        status: states.includes("outage")
          ? ("outage" as const)
          : states.includes("degraded")
            ? ("degraded" as const)
            : ("operational" as const),
        updatedAt: at.toISOString(),
        components,
      };
    },
  };
}

export type StatusService = ReturnType<typeof createStatusService>;
