import type { Env } from "../config/env.js";
import type { Logger } from "./logger.js";

export type Alerter = (message: string) => Promise<void>;

/** Posts to the Telegram bot when configured; otherwise alerts are only logged. */
export function createAlerter(
  env: Pick<Env, "ALERT_TELEGRAM_BOT_TOKEN" | "ALERT_TELEGRAM_CHAT_ID">,
  logger: Logger,
): Alerter {
  const token = env.ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = env.ALERT_TELEGRAM_CHAT_ID;
  return async (message) => {
    logger.warn({ alert: message }, "ALERT");
    if (!token || !chatId) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `[Webhook] ${message}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.error({ status: res.status }, "telegram alert failed");
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "telegram alert failed");
    }
  };
}
