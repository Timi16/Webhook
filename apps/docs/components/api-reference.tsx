'use client';

import dynamic from 'next/dynamic';
import '@scalar/api-reference-react/style.css';

// Scalar renders in the browser only; the spec is generated from the API's Zod schemas at build time.
const ApiReferenceReact = dynamic(
  () => import('@scalar/api-reference-react').then((mod) => mod.ApiReferenceReact),
  { ssr: false, loading: () => <p className="p-6 text-sm text-fd-muted-foreground">Loading the API reference...</p> },
);

export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: '/openapi.json',
        hideClientButton: true,
        hideDarkModeToggle: true,
        withDefaultFonts: false,
      }}
    />
  );
}
