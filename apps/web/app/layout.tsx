import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/theme";
import "./styles/app.css";
import "./styles/lagos.css";
import "./styles/web.css";

export const metadata: Metadata = {
  title: { default: "Webhook", template: "%s · Webhook" },
  description:
    "Payment webhooks for Stellar Testnet: watch a wallet, get a signed event when it is paid.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
