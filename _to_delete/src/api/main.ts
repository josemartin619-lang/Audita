/**
 * API entrypoint. Seeds a demo firm and starts the HTTP server.
 * Run: `npm run api`  →  http://localhost:3000  (UI) and /api/* (JSON).
 */

import { createApp } from './server.js';
import { seedFirm } from './seed.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const firm = await seedFirm();
  const app = createApp(firm);
  app.listen(PORT, () => {
    console.log(`Audita API + UI en http://localhost:${PORT}`);
    console.log(`API key (x-api-key): ${process.env.AUDITA_API_KEY ?? 'dev-key'}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
