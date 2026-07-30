/**
 * PgBlobBackend — the durable half of `store.ts`.
 *
 * This is deliberately the dumbest possible thing that survives a cold start: a
 * single table of (file name -> JSON text), loaded wholesale on boot and upserted
 * on every write. It exists so a serverless deploy stops losing posted entries
 * the moment the microVM is recycled.
 *
 * Known limitation, stated plainly rather than hidden: blobs are whole-file, so
 * two concurrent instances writing the same file are last-writer-wins. That is
 * acceptable for a single-firm demo or a small deployment and is NOT acceptable
 * at scale. The real fix already exists in `pg/pgRepo.ts` (row-level Postgres
 * for the ledger); this backend is what makes the auxiliary state (contacts,
 * products, templates, sign-offs) and the file-based repo durable without
 * rewriting every synchronous call site in server.ts.
 *
 * Imported lazily from store.ts so a machine with no DATABASE_URL never opens a
 * pool.
 */

import { Pool } from 'pg';
import type { BlobBackend } from './store.js';

/** Managed Postgres (Neon, Supabase, RDS) terminates plaintext connections. */
function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  if (/[?&]sslmode=disable/.test(url)) return false;
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  // Hosted providers use certificates this process has no CA bundle for. We
  // still get transport encryption; we do not get certificate pinning.
  return { rejectUnauthorized: false };
}

export class PgBlobBackend implements BlobBackend {
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      ssl: sslFor(url),
      // One connection per instance: a serverless function handles one request
      // at a time, and pgbouncer-fronted providers punish large pools.
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pool-level error with no listener is an unhandled 'error' event, which
    // kills the process. Managed providers drop idle connections routinely.
    this.pool.on('error', (e) => {
      console.error('[pgBlobs] idle client error:', e.message);
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS kv (
        file       TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async load(): Promise<Map<string, string>> {
    const res = await this.pool.query<{ file: string; body: string }>(
      'SELECT file, body FROM kv',
    );
    const out = new Map<string, string>();
    for (const r of res.rows) out.set(r.file, r.body);
    return out;
  }

  async put(file: string, body: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO kv (file, body, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (file) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [file, body],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
