/**
 * API entrypoint. Seeds a demo firm and starts the HTTP server.
 * Run: `npm run api`  →  http://localhost:3000  (UI) and /api/* (JSON).
 */

import { createApp } from './server.js';
import { seedFirm } from './seed.js';
import { seedUsers } from './auth.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  // Refuse to boot in production with the default dev secret.
  if (process.env.NODE_ENV === 'production' &&
      (!process.env.AUDITA_JWT_SECRET || process.env.AUDITA_JWT_SECRET === 'dev-secret-change-me')) {
    console.error('FATAL: set AUDITA_JWT_SECRET to a strong random value before running in production.');
    process.exit(1);
  }
  const firm = await seedFirm();
  const users = seedUsers();
  const app = createApp(firm, users);
  app.listen(PORT, () => {
    console.log(`Audita API + UI en http://localhost:${PORT}`);
    console.log('Demo logins (password: audita):');
    console.log('  ana@audita.co (partner) · carlos@audita.co (accountant) · sofia@audita.co (staff) · cliente@andina.co (viewer)');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
