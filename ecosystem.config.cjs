// pm2 process file for the two backend processes.
//
//   pnpm install && pnpm build
//   pnpm --filter @webhook/api db:deploy
//   pm2 start ecosystem.config.cjs                    # uses NODE_ENV from apps/api/.env
//   pm2 start ecosystem.config.cjs --env production   # forces NODE_ENV=production
//   pm2 logs | pm2 reload webhook-api | pm2 restart webhook-worker | pm2 save
//
// The file is .cjs because the repo is ESM ("type": "module") and pm2 loads it with require().
const path = require("node:path");

const common = {
  cwd: path.join(__dirname, "apps/api"),
  interpreter: "node",
  // Everything else comes from apps/api/.env; variables set here or in the shell win over it.
  node_args: "--env-file=.env --max-old-space-size=192",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_memory_restart: "256M",
  // Both processes shut down gracefully within 10 s (in-flight requests and sends).
  kill_timeout: 12000,
  // A crash loop backs off instead of spinning: 1 s, 1.5 s, ... up to 15 s.
  exp_backoff_restart_delay: 1000,
  time: true,
  merge_logs: true,
  env_production: { NODE_ENV: "production" },
};

module.exports = {
  apps: [
    { ...common, name: "webhook-api", script: "dist/server.js" },
    // Exactly one worker: it owns the ingestion cursor and the delivery queue. The watchdog
    // exits the process on a stalled loop and pm2 starts it again.
    { ...common, name: "webhook-worker", script: "dist/worker.js" },
  ],
};
