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
  ],
};
