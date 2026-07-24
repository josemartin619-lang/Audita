/**
 * API entrypoint. Boots the firm with DURABLE storage: each client's books are
 * persisted to a JSON file and reloaded on restart, so anything you add stays.
 * The demo firm is seeded only on the very first run (empty data dir).
 * Run: `npm run api`  →  http://localhost:3000
 */

import { createApp } from './server.js';
import { seedInto } from './seed.js';
import { seedUsers } from './auth.js';
import { FirmWorkspace, type ClientMeta } from '../services/firmWorkspace.js';
import { MemoryRepository } from '../persistence/memoryRepo.js';
import { pesos } from '../domain/money.js';
import { Collection } from '../persistence/store.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  if (process.env.NODE_ENV === 'production' &&
      (!process.env.AUDITA_JWT_SECRET || process.env.AUDITA_JWT_SECRET === 'dev-secret-change-me')) {
    console.error('FATAL: set AUDITA_JWT_SECRET to a strong random value before running in production.');
    process.exit(1);
  }

  const clientStore = new Collection<ClientMeta>('clients.json');
  const firm = new FirmWorkspace({
    user: 'a.alfaris',
    approvalThreshold: pesos(1_000_000),
    relatedParties: ['Al-Faris Holding', 'Family Investments'],
    // durable, tenant-isolated storage: one JSON file per client's books
    repoFactory: (clientId) => new MemoryRepository(`client-${clientId}.json`),
  });

  if (clientStore.values().length === 0) {
    // First run: seed the demo firm and remember which clients exist.
    await seedInto(firm);
    for (const m of firm.listClients()) clientStore.set(m.clientId, m);
    console.log('First run — seeded demo firm and saved to disk.');
  } else {
    // Subsequent runs: re-open each saved client (its repo loads from disk).
    for (const m of clientStore.values()) firm.addClient(m);
    console.log(`Loaded ${clientStore.values().length} client(s) from disk.`);
  }

  const users = seedUsers();
  const app = createApp(firm, users, clientStore);
  app.listen(PORT, () => {
    console.log(`Audita — running at http://localhost:${PORT}`);
    console.log('Demo logins (password: audita): ana@audita.co · carlos@audita.co · sofia@audita.co');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
