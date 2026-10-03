import type { Metadata } from 'next';
import { ApiReferenceFrame } from '@/components/api-reference-frame';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'Every endpoint of the Webhook REST API, generated from the schemas that validate requests.',
};

export default function ApiReferencePage() {
  return <ApiReferenceFrame />;
}
