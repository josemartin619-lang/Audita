/**
 * File-backed persistence. The app was in-memory only, so anything you added
 * vanished on restart — which made it feel like a demo, not software. This
 * module gives durable storage with a small footprint: JSON files under a data
 * directory, with a replacer/reviver that round-trips `bigint` money safely
 * (money is stored as integer minor units, never floats, so it MUST survive
 * serialization exactly).
 */

import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.AUDITA_DATA_DIR
  ? path.resolve(process.env.AUDITA_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** bigint -> {"__big":"123"} on write, back to bigint on read. */
const replacer = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? { __big: v.toString() } : v;
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '__big' in (v as Record<string, unknown>)
    ? BigInt((v as { __big: string }).__big)
    : v;

export function readJson<T>(file: string, fallback: T): T {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'), reviver) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, replacer, 0), 'utf8');
  fs.renameSync(tmp, p); // atomic-ish swap so a crash mid-write can't corrupt
}

export function dataFileExists(file: string): boolean {
  return fs.existsSync(path.join(DATA_DIR, file));
}

/**
 * A tiny durable key/value collection. Used for the auxiliary app state that
 * lives outside the ledger repo (contacts, products, subledger items,
 * templates, checklist sign-offs). Writes are flushed to disk immediately so a
 * restart never loses an add.
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
