/**
 * Persisted period locks.
 *
 * `LedgerService` keeps closed periods in a `Set` in memory. That set is the
 * thing that refuses a back-dated entry into a closed month, so losing it on
 * restart does not merely lose a preference — it silently reopens a closed
 * period and lets someone post into a signed-off month. On serverless, where a
 * cold start happens routinely, that would happen constantly.
 *
 * One shared collection, so the boot path that restores locks and the routes
 * that set them are looking at the same object rather than two copies of one
 * file.
 */

import { Collection } from '../persistence/store.js';

export interface LockRecord {
  clientId: string;
  periods: string[];
}

let col: Collection<LockRecord> | null = null;

/** Lazily constructed, because Collection reads at construction and the store
 *  must be hydrated first. */
export function locksCollection(): Collection<LockRecord> {
  if (!col) col = new Collection<LockRecord>('period-locks.json');
  return col;
}

/** Shape expected by FirmWorkspace.resumeAll(). */
export function locksByClient(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of locksCollection().values()) out[r.clientId] = r.periods;
  return out;
}

/** Test seam. */
export function __resetLocksForTests(): void { col = null; }
