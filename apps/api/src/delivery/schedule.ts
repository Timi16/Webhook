export const MAX_ATTEMPTS = 10;

/** Delay after failed attempts 1 to 9. Attempt 10 failing ends the delivery as FAILED. */
export const RETRY_DELAYS_SECONDS = [
  30, 120, 600, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400,
] as const;

const JITTER = 0.2;

/** Delay before the next attempt, with +/-20% random jitter. Null when there are no attempts left. */
export function nextDelayMs(
  failedAttempt: number,
  random: () => number = Math.random,
): number | null {
  if (failedAttempt < 1 || failedAttempt >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_SECONDS[failedAttempt - 1];
  if (base === undefined) return null;
  return Math.round(base * 1000 * (1 - JITTER + random() * 2 * JITTER));
}
