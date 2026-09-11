/**
 * PM2 process topology for the P3 split. Replaces the single `paylode-api` app
 * with a cohesive money core + three independently deployable product services,
 * all from this one codebase (each entrypoint mounts a module subset).
 *
 * Deploy ONE product without touching the gateway:
 *   pm2 reload paylode-invoicing          # core + wallet + assistant untouched
 *
 * A local nginx router on 176 (:3000) path-routes to these ports, so the public
 * API base URL is unchanged (see nginx/paylode-176-router.conf). Start with:
 *   cd /opt/paylode-api/backend && pm2 start ecosystem.config.js
 *
 * Rollback to the monolith: `pm2 start src/server.js --name paylode-api -i max`
 * on :3000 and point nginx back at it (the monolith still works unchanged).
 */
module.exports = {
  apps: [
    {
      name: 'paylode-core',            // money organism + all non-product core routes
      script: 'src/entrypoints/core.js',
      exec_mode: 'cluster',
      instances: 2,                    // bg jobs (railFloat/payoutSettle) run on instance 0 only
      env: { NODE_ENV: 'production', CORE_PORT: 3001 },
      max_memory_restart: '600M',
    },
    {
      name: 'paylode-invoicing',
      script: 'src/entrypoints/invoicing.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', INVOICING_PORT: 3101 },
      max_memory_restart: '400M',
    },
    {
      name: 'paylode-wallet',
      script: 'src/entrypoints/wallet.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', WALLET_PORT: 3102 },
      max_memory_restart: '400M',
    },
    {
      name: 'paylode-assistant',
      script: 'src/entrypoints/assistant.js',
      exec_mode: 'fork',
      instances: 1,
      env: { NODE_ENV: 'production', ASSISTANT_PORT: 3103 },
      max_memory_restart: '400M',
    },

    // Existing background workers (unchanged) — kept as their own processes.
    { name: 'invoicingWorker', script: 'src/workers/invoicingWorker.js', exec_mode: 'fork', instances: 1, env: { NODE_ENV: 'production' } },
    { name: 'webhookWorker',   script: 'src/workers/webhookWorker.js',   exec_mode: 'fork', instances: 1, env: { NODE_ENV: 'production' } },

    // Daily merchant payout-by-bank report — 06:00 WAT (05:00 UTC)
    { name: 'bucksnostar-daily-report', script: 'src/cron/merchantDailyReport.js', exec_mode: 'fork', instances: 1, cron_restart: '0 5 * * *', autorestart: false, env: { NODE_ENV: 'production' } },

    // Parallex debit alert IMAP reader — every 15 min; matches alerts vs rail_disbursements
    { name: 'parallex-alert-sync', script: 'src/cron/parallexAlertSync.js', exec_mode: 'fork', instances: 1, cron_restart: '*/15 * * * *', autorestart: false, env: { NODE_ENV: 'production' } },

    // Payout watchdog — persistent fork, self-ticks every 5 min via setInterval.
    // Finds payout_items stuck in 'processing' > 15 min, queries Parallex for true status,
    // auto-refunds on fail. Deploy note: stop the old manually-started watchdog first:
    //   pm2 delete payoutWatchdog   (or whatever name it was started with)
    { name: 'payout-watchdog', script: 'src/cron/payoutWatchdog.js', exec_mode: 'fork', instances: 1, autorestart: true, env: { NODE_ENV: 'production' } },

    // Alert when rail_disbursements legs are stuck as 'sent' > 20 min — every 10 min
    { name: 'payout-sent-alert', script: 'src/cron/payoutSentAlert.js', exec_mode: 'fork', instances: 1, cron_restart: '*/10 * * * *', autorestart: false, env: { NODE_ENV: 'production' } },

    // Rail balance drift check — compare live bank balance vs DB merchant wallet sums; 08:00 & 18:00 WAT
    { name: 'rail-drift-alert', script: 'src/cron/railDriftAlert.js', exec_mode: 'fork', instances: 1, cron_restart: '0 7,17 * * *', autorestart: false, env: { NODE_ENV: 'production' } },
  ],
};
