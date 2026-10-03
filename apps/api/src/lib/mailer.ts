import type { Env } from "../config/env.js";
import type { Logger } from "./logger.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through Resend when RESEND_API_KEY is set; otherwise emails are only logged. */
export function createMailer(
  env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM" | "NODE_ENV">,
  logger: Logger,
): Mailer {
  return {
    async send(mail) {
      if (!env.RESEND_API_KEY) {
        // The body can hold a reset link, so it is only printed on a developer's machine.
        const body = env.NODE_ENV === "development" ? { text: mail.text } : {};
        logger.info(
          { to: mail.to, subject: mail.subject, ...body },
          "email not sent (RESEND_API_KEY is not set)",
        );
        return;
      }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok)
          logger.error({ status: res.status, subject: mail.subject }, "email send failed");
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : err, subject: mail.subject },
          "email send failed",
        );
      }
    },
  };
}
