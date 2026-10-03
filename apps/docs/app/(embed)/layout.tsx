import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// A separate document for the API reference. Scalar's stylesheet styles `body` and `:root`, so
// it must never share a page with the guides; it is shown inside an iframe instead.
export const metadata: Metadata = {
  title: 'API reference',
  robots: { index: false },
};

export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
