// Adds a code example for every client library to the generated OpenAPI document, so the
// "Client Libraries" box in the API reference shows real code for each language.
//
// The examples are produced by Scalar's own snippet generator, the same one that renders the
// sample beside every endpoint, so they always match what the reference shows further down.
import { readFileSync, writeFileSync } from 'node:fs';
import { snippetz } from '@scalar/snippetz';

const file = new URL('../public/openapi.json', import.meta.url);
const document = JSON.parse(readFileSync(file, 'utf8'));
const server = document.servers?.[0]?.url ?? 'https://api.your-domain.com';
const authorization = { name: 'Authorization', value: 'Bearer whk_test_YOUR_API_KEY' };

const requests = [
  {
    title: 'List your watches',
    request: { url: `${server}/v1/watches`, method: 'GET', headers: [authorization] },
  },
  {
    title: 'Watch a wallet',
    request: {
      url: `${server}/v1/watches`,
      method: 'POST',
      headers: [authorization, { name: 'Content-Type', value: 'application/json' }],
      postData: {
        mimeType: 'application/json',
        text: JSON.stringify({
          walletAddress: 'GBFMHWFQFQV3ZGGTWFFBGJQJPTRX3UBT7ZWBMUELVHJIUBSFDP5HQD56',
          endpointId: 'YOUR_ENDPOINT_ID',
          assets: [{ code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }],
          amountRule: { kind: 'min', amount: '10' },
          memoRule: { kind: 'present' },
        }),
      },
    },
  },
];

// Most used first, then the rest in alphabetical order.
const FIRST = ['shell', 'node', 'python', 'ruby', 'php'];
// Syntax highlighting names where they differ from the generator's target key.
const HIGHLIGHT = { shell: 'bash', node: 'js', objc: 'objectivec', http: 'http' };

const generator = snippetz();
const targets = generator
  .clients()
  .sort((a, b) => {
    const [ia, ib] = [FIRST.indexOf(a.key), FIRST.indexOf(b.key)];
    if (ia !== -1 || ib !== -1) return (ia === -1 ? FIRST.length : ia) - (ib === -1 ? FIRST.length : ib);
    return a.title.localeCompare(b.title);
  });

const examples = [];
for (const target of targets) {
  const client = target.clients.find((c) => c.client === target.default) ?? target.clients[0];
  const sections = [];
  for (const { title, request } of requests) {
    const code = generator.print(target.key, client.client, request);
    if (!code) continue;
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    sections.push(`**${title}**\n\n${fence}${HIGHLIGHT[target.key] ?? target.key}\n${code.trim()}\n${fence}`);
  }
  if (sections.length === 0) continue;
  examples.push({
    lang: target.title,
    description: `Using \`${client.title}\`. Every endpoint below has the same language menu beside its sample.\n\n${sections.join('\n\n')}`,
  });
}

document.info['x-scalar-sdk-installation'] = examples;
writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Added client examples for ${examples.length} languages: ${examples.map((e) => e.lang).join(', ')}`);
