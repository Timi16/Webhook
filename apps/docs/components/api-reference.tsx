'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import '@scalar/api-reference-react/style.css';

// Scalar renders in the browser only; the spec is generated from the API's Zod schemas at build time.
const ApiReferenceReact = dynamic(
  () => import('@scalar/api-reference-react').then((mod) => mod.ApiReferenceReact),
  { ssr: false },
);

/** Rendered alone in its own document (see app/(embed)); the theme comes from the parent page. */
export function ApiReference() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('theme');
    setTheme(requested === 'dark' ? 'dark' : 'light');
  }, []);

  if (!theme) return null;
  return (
    <ApiReferenceReact
      configuration={{
        url: '/openapi.json',
        darkMode: theme === 'dark',
        forceDarkModeState: theme,
        hideDarkModeToggle: true,
        hideClientButton: true,
        // Reference only: no editor toolbar, AI chat or MCP generator.
        showDeveloperTools: 'never',
        agent: { disabled: true },
        mcp: { disabled: true },
      }}
    />
  );
}
