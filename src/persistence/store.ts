/**
 * Persistence for the auxiliary app state, written to survive three very
 * different hosts without the callers knowing which one they are on.
 *
 * The original version wrote JSON straight to a data directory. That works on a
 * laptop and in Docker with a volume, and fails silently on serverless: Vercel
 * gives you a READ-ONLY filesystem with a writable `/tmp` that belongs to one
 * microVM and is discarded when the function is archived. A ledger that forgets
 * posted entries is worse than no ledger, so this module now has three modes:
 *
 *   postgres  — DATABASE_URL is set. Every blob is mirrored to a `kv` table and
 *               loaded back on cold start. Durable. This is production.
 *   disk      — a writable data directory (laptop, Docker with a volume).
 *   ephemeral — neither. Data lives in memory and in /tmp for as long as this
 *               instance survives, and the UI says so in a banner.
 *
 * The public API stays SYNCHRONOUS on purpose. `Collection` and
 * `MemoryRepository` are used from dozens of synchronous call sites in
 * server.ts; making them async would ripple through the whole API layer. So
 * reads are served from an in-memory cache that is hydrated once per cold start
 * by `hydrateStore()`, and writes update the cache synchronously while the
 * durable write happens in the background. Callers that need the durable write
 * to have landed — every HTTP handler, because a 201 must not lie — await
 * `flushWrites()`. On Vercel the request handler does that for you.
 *
 * Money is stored as integer minor units in `bigint`, never as a float, so the
 * replacer/reviver below MUST round-trip it exactly.
 */

import fs from 'node:fs';
import path from 'node:path';

/** True on Vercel / Lambda, where the filesystem is read-only apart from /tmp. */
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const DATA_DIR = process.env.AUDITA_DATA_DIR
  ? path.resolve(process.env.AUDITA_DATA_DIR)
  : SERVERLESS
    ? '/tmp/audita-data'
    : path.resolve(process.cwd(), 'data');

/**
 * `unavailable` is the important one: DATABASE_URL is configured but the
 * database was never reached. That must NOT look like `ephemeral`, because
 * `ephemeral` is a deliberate demo choice while `unavailable` is a production
 * instance that will lose everything written to it.
 */
export type StorageMode = 'postgres' | 'disk' | 'ephemeral' | 'unavailable';

/** Contract a durable backend must satisfy. Implemented by the Postgres kv. */
export interface BlobBackend {
  load(): Promise<Map<string, string>>;
  put(file: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** file name -> serialized JSON. The single source of truth for reads. */
const cache = new Map<string, string>();
let backend: BlobBackend | null = null;
let diskWritable = false;
let hydrated = false;
let hydrating: Promise<StorageMode> | null = null;

/** In-flight durable writes, awaited by flushWrites(). */
const inflight = new Set<Promise<unknown>>();

function ensureDir(): boolean {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch {
    // EROFS on a read-only filesystem. Not fatal — the cache still works.
    return false;
  }
}

export function storageMode(): StorageMode {
  if (backend) return 'postgres';
  // Configured for a database but not attached to one. Never report this as a
  // benign mode — someone set DATABASE_URL precisely because they expect their
  // data to be kept.
  if (process.env.DATABASE_URL) return 'unavailable';
  if (diskWritable && !SERVERLESS) return 'disk';
  return 'ephemeral';
}

/** Human-readable one-liner for the health endpoint and the UI banner. */
export function storageDescription(): string {
  switch (storageMode()) {
    case 'postgres':
      return 'Durable — every change is written to Postgres.';
    case 'disk':
      return `Durable — every change is written to ${DATA_DIR}.`;
    case 'unavailable':
      return 'BROKEN — DATABASE_URL is set but the database could not be reached, '
        + 'so nothing can be saved. Fix the connection before entering any data.';
    default:
      return 'NOT DURABLE — this instance keeps data in memory only. '
        + 'Set DATABASE_URL to make posted entries survive a restart.';
  }
}

// ---------------------------------------------------------------------------
// bigint-safe JSON
// ---------------------------------------------------------------------------

const replacer = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? { __big: v.toString() } : v;
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '__big' in (v as Record<string, unknown>)
    ? BigInt((v as { __big: string }).__big)
    : v;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * Called once per process (or per serverless cold start) BEFORE the app is
 * built, because `new Collection(...)` reads synchronously at construction and
 * therefore needs the cache already warm.
 *
 * Order matters: Postgres wins over disk. If the DB is configured but
 * unreachable we throw rather than silently degrading to ephemeral — a
 * production deploy quietly losing data is precisely the failure this whole
 * module exists to prevent.
 */
export async function hydrateStore(): Promise<StorageMode> {
  if (hydrated) return storageMode();
  // Gate concurrent callers onto one attempt, so two in-flight requests on a
  // cold start cannot open two connection pools.
  if (!hydrating) hydrating = doHydrate().finally(() => { hydrating = null; });
  return hydrating;
}

async function doHydrate(): Promise<StorageMode> {
  diskWritable = ensureDir();

  const url = process.env.DATABASE_URL;
  if (url) {
    // Imported lazily so a laptop with no DATABASE_URL never opens a pool.
    const { PgBlobBackend } = await import('./pgBlobs.js');
    const pg = new PgBlobBackend(url);
    try {
      await pg.init();
      const rows = await pg.load();
      for (const [k, v] of rows) cache.set(k, v);
    } catch (e) {
      // Do NOT mark the store hydrated: leaving it unhydrated is what lets the
      // next request try again instead of the instance limping along for its
      // whole lifetime with nowhere to write.
      await pg.close().catch(() => { /* already broken */ });
      throw e;
    }
    backend = pg;
    hydrated = true;
    return 'postgres';
  }

  // No database. Warm the cache from whatever is on disk, if anything.
  if (diskWritable) {
    try {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          cache.set(f, fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        } catch { /* unreadable file — treat as absent */ }
      }
    } catch { /* directory vanished — treat as empty */ }
  }
  hydrated = true;
  return storageMode();
}

/**
 * Resolve once every durable write issued so far has landed. HTTP handlers must
 * await this before responding, otherwise a serverless instance can be frozen
 * between "201 Created" and the row actually existing.
 *
 * THROWS if any of those writes failed. That is the point: the caller is about
 * to tell a user their journal entry was saved, and it must not say so when the
 * only durable copy never got written.
 */
export async function flushWrites(): Promise<void> {
  const failures: unknown[] = [];
  while (inflight.size) {
    const settled = await Promise.allSettled([...inflight]);
    for (const r of settled) if (r.status === 'rejected') failures.push(r.reason);
  }
  if (failures.length > 0) {
    const first = failures[0];
    throw new Error(
      `durable write failed (${failures.length}): `
      + (first instanceof Error ? first.message : String(first)),
    );
  }
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

function readRaw(file: string): string | null {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  if (!diskWritable && !fs.existsSync(DATA_DIR)) return null;
  const p = path.join(DATA_DIR, file);
  try {
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, 'utf8');
    cache.set(file, text);
    return text;
  } catch {
    return null;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  const text = readRaw(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text, reviver) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  const text = JSON.stringify(value, replacer, 0);
  // 1. The cache is authoritative and updates synchronously, so a read
  //    immediately after a write always sees the new value.
  cache.set(file, text);

  // 2. Disk, when writable. Best effort: on a read-only filesystem this is
  //    expected to fail and must not take the request down.
  if (diskWritable) {
    const p = path.join(DATA_DIR, file);
    try {
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, p); // atomic-ish swap: a crash mid-write can't corrupt
    } catch {
      diskWritable = false; // stop trying; we know now
    }
  }

  // 3. The durable backend, tracked so flushWrites() can await it.
  if (backend) {
    const task = backend.put(file, text)
      .catch((e: unknown) => {
        console.error(`[store] durable write failed for ${file}:`, e);
        throw e;
      })
      .finally(() => { inflight.delete(task); });
    inflight.add(task);
  }
}

export function dataFileExists(file: string): boolean {
  return readRaw(file) !== null;
}

/**
 * A tiny durable key/value collection. Used for the auxiliary app state that
 * lives outside the ledger repo (contacts, products, subledger items,
 * templates, checklist sign-offs). Every mutation is flushed, so a restart
 * never loses an add — provided the process is running in `postgres` or `disk`
 * mode. In `ephemeral` mode nothing outlives the instance, which is why the UI
 * says so out loud.
 */
export class Collection<T> {
  private map = new Map<string, T>();
  constructor(private readonly file: string) {
    const raw = readJson<[string, T][]>(this.file, []);
    for (const [k, v] of raw) this.map.set(k, v);
  }
  private flush() { writeJson(this.file, [...this.map.entries()]); }
  get(id: string): T | undefined { return this.map.get(id); }
  set(id: string, v: T): void { this.map.set(id, v); this.flush(); }
  delete(id: string): boolean { const ok = this.map.delete(id); this.flush(); return ok; }
  values(): T[] { return [...this.map.values()]; }
  has(id: string): boolean { return this.map.has(id); }
}

/** Test seam: forget everything and allow re-hydration. */
export function __resetStoreForTests(): void {
  cache.clear();
  inflight.clear();
  backend = null;
  hydrated = false;
  hydrating = null;
  diskWritable = false;
}
