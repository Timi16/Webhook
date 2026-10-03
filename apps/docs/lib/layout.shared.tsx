import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      { text: 'Guides', url: '/docs', active: 'nested-url' },
      { text: 'API reference', url: '/api-reference', active: 'nested-url' },
    ],
  };
}
