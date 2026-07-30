/**
 * Shared boot sequence for every host: `npm run api` on a laptop, Docker,
 * Render, and the Vercel serverless handler in `api/index.js`.
 *
 * It exists so the serverless entrypoint cannot drift away from the long-running
 * server. There is exactly one place that decides the order of operations, and
 * that order is not negotiable:
 *
 *   1. hydrateStore()   — the cache must be warm BEFORE step 3, because
 *                         `new Collection(...)` and `MemoryRepository` read
 *                         synchronously at construction.
 *   2. secret check     — refuse to serve production traffic with the dev JWT
 *                         secret. Throws a message naming the variable.
 *   3. build the firm   — seed on first run, otherwise re-open saved clients.
 */

import { createApp } from './server.js';
import { seedInto } from './seed.js';
import { seedUsers } from './auth.js';
import { FirmWorkspace, type ClientMeta } from '../services/firmWorkspace.js';
import { MemoryRepository } from '../persistence/memoryRepo.js';
import { pesos } from '../domain/money.js';
import { Collection, hydrateStore, storageDescription, storageMode } from '../persistence/store.js';
import { locksByClient } from './locks.js';

export class ConfigError extends Error {}

/** Throws ConfigError when production config is missing. Never guesses. */
export function assertProductionConfig(): void {
  const secret = process.env.AUDITA_JWT_SECRET;
  if (process.env.NODE_ENV !== 'production') return;
  if (!secret || secret === 'dev-secret-change-me') {
    throw new ConfigError(
      'AUDITA_JWT_SECRET is not set (or is still the development default). '
      + 'Set it to a long random value in your host\'s environment variables '
      + 'before serving production traffic — without it, anyone can mint a '
      + 'valid session token for any user.',
    );
  }
}

export interface BootResult {
  app: ReturnType<typeof createApp>;
  storage: ReturnType<typeof storageMode>;
  clients: number;
  seeded: boolean;
}

export async function boot(): Promise<BootResult> {
  const storage = await hydrateStore();
  assertProductionConfig();

  const clientStore = new Collection<ClientMeta>('clients.json');
  const firm = new FirmWorkspace({
    user: 'a.alfaris',
    approvalThreshold: pesos(1_000_000),
    relatedParties: ['Al-Faris Holding', 'Family Investments'],
    // Tenant-isolated storage: one blob per client's books.
    repoFactory: (clientId) => new MemoryRepository(`client-${clientId}.json`),
  });

  let seeded = false;
  if (clientStore.values().length === 0) {
    await seedInto(firm);
    for (const m of firm.listClients()) clientStore.set(m.clientId, m);
    seeded = true;
  } else {
    for (const m of clientStore.values()) firm.addClient(m);
    // Re-opened books already contain entries, findings, invoices and an audit
    // chain. Recover the id counters, rehydrate the chain, and restore closed
    // periods. Without this the first posting of the process collides with a
    // stored id and fails. See LedgerService.resume().
    await firm.resumeAll(locksByClient());
  }

  const app = createApp(firm, seedUsers(), clientStore);
  return { app, storage, clients: clientStore.values().length, seeded };
}

/** One line to stdout so the storage mode is never a mystery in the logs. */
export function logBoot(r: BootResult): void {
  console.log(`[audita] storage=${r.storage} — ${storageDescription()}`);
  console.log(r.seeded
    ? '[audita] first run — seeded the demo firm.'
    : `[audita] loaded ${r.clients} client(s) from storage.`);
}
