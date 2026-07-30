/**
 * Long-running API entrypoint (laptop, Docker, Render).
 * Run: `npm run api`  →  http://localhost:3000
 *
 * All the ordering logic lives in boot.ts, which the Vercel handler shares.
 */

import { boot, logBoot, ConfigError } from './boot.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const result = await boot();
  logBoot(result);
  result.app.listen(PORT, () => {
    console.log(`Audita — running at http://localhost:${PORT}`);
    console.log('Demo logins (password: audita): ana@audita.co · carlos@audita.co · sofia@audita.co');
  });
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
