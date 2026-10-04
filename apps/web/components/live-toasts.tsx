"use client";

import { useEffect } from "react";
import { subscribeLive } from "@/lib/live";
import { useToast } from "./toast";

/** Tells you when a payment lands or a webhook gives up, whichever screen you are on. */
export function LiveToasts() {
  const toast = useToast();
  useEffect(
    () =>
      subscribeLive((name, data) => {
        if (name === "payment.detected" && typeof data.paymentId === "string") {
          const verified = data.outcome === "VERIFIED";
          toast(verified ? "Payment verified" : "Payment rejected", {
            tone: verified ? "ok" : "bad",
            href: `/payments/view?id=${encodeURIComponent(data.paymentId)}`,
          });
        }
        if (
          name === "delivery.updated" &&
          data.status === "FAILED" &&
          typeof data.eventId === "string"
        ) {
          toast("A webhook failed after every retry", {
            tone: "bad",
            href: `/events/view?id=${data.eventId}`,
          });
        }
        if (name === "endpoint.updated" && data.status === "DISABLED") {
          toast("An endpoint was disabled", { tone: "bad", href: "/endpoints" });
        }
      }),
    [toast],
  );
  return null;
}
