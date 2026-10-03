import type { Metadata } from 'next';
import { ApiReference } from '@/components/api-reference';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'Every endpoint of the Webhook REST API, generated from the schemas that validate requests.',
};

export default function ApiReferencePage() {
  return <ApiReference />;
}
