// Generates public/openapi.json from the API's own schemas, with the address from site.json as
// the server URL (API_PUBLIC_URL overrides it), then adds the client-library examples.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const site = JSON.parse(readFileSync(new URL('../site.json', import.meta.url), 'utf8'));
const env = { ...process.env, API_PUBLIC_URL: process.env.API_PUBLIC_URL ?? site.apiUrl };
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', env });

run('pnpm', ['--filter', '@webhook/api', 'openapi', '../docs/public/openapi.json']);
run('node', ['scripts/client-examples.mjs']);
