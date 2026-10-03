'use client';

import { useEffect, useState } from 'react';

/**
 * Shows the API reference in an iframe so its global styles cannot leak into the rest of the
 * site, and keeps it on the same light or dark theme as the page around it.
 */
export function ApiReferenceFrame() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  if (!theme) return <div className="flex-1" />;
  return (
    <iframe
      key={theme}
      src={`/reference-embed?theme=${theme}`}
      title="Webhook API reference"
      className="w-full flex-1 border-0"
      style={{ minHeight: 'calc(100dvh - var(--fd-nav-height, 3.5rem))' }}
    />
  );
}
