// Points the docs at the real addresses, once, when the domain exists:
//   pnpm --filter @webhook/docs set-urls https://api.example.com https://app.example.com
// It updates site.json, the `export API` line and the signup link in the quickstart, then regenerates the API
// reference so every code sample shows the same address.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [apiUrl, dashboardUrl] = process.argv.slice(2).map((url) => url?.replace(/\/+$/, ''));
const valid = (url) => typeof url === 'string' && /^https?:\/\/[^\s/]+$/.test(url);
if (!valid(apiUrl) || !valid(dashboardUrl)) {
  console.error('Usage: set-urls <api address> <dashboard address>, each like https://api.example.com');
  process.exit(1);
}

const sitePath = new URL('../site.json', import.meta.url);
writeFileSync(sitePath, `${JSON.stringify({ apiUrl, dashboardUrl }, null, 2)}\n`);

const quickstartPath = new URL('../content/docs/quickstart.mdx', import.meta.url);
const quickstart = readFileSync(quickstartPath, 'utf8');
const updated = quickstart
  .replace(/^export API=\S+/m, `export API=${apiUrl}`)
  .replace(/\]\(https?:\/\/[^)\s]+\/signup\)/, `](${dashboardUrl}/signup)`);
if (updated === quickstart && !quickstart.includes(`export API=${apiUrl}`)) {
  console.error('Could not find the export lines in quickstart.mdx');
  process.exit(1);
}
writeFileSync(quickstartPath, updated);

execFileSync('node', ['scripts/openapi.mjs'], { stdio: 'inherit' });
console.log(`Docs now point at ${apiUrl} (API) and ${dashboardUrl} (dashboard).`);
