/**
 * Immutable audit trail — an append-only, hash-chained log of every event that
 * touches the books. Each event stores the hash of the previous event, so any
 * retroactive alteration breaks the chain and is detectable WITHOUT trusting
 * the operator. This is the architectural heart of "audit-first".
 */

import { createHash } from 'node:crypto';

export type AuditAction =
  | 'POST_ENTRY'
  | 'REVERSE_ENTRY'
  | 'ISSUE_INVOICE'
  | 'RAISE_FINDING'
  | 'FINDING_STATUS'
  | 'WORKING_PAPER'
  | 'PERIOD_CLOSE';

export interface AuditEvent {
  seq: number;
  action: AuditAction;
  /** Business reference (entry id, invoice number, finding id...). */
  ref: string;
  /** Arbitrary structured detail; included in the hash. */
  detail: Record<string, unknown>;
  user: string;
  ts: string; // ISO timestamp
  prevHash: string;
  hash: string;
}

export const GENESIS = 'GENESIS';

/** Deterministic JSON — stable key order — so hashing is reproducible. */
function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export function hashEvent(
  e: Omit<AuditEvent, 'hash'>,
): string {
  const material = canonical({
    seq: e.seq,
    action: e.action,
    ref: e.ref,
    detail: e.detail,
    user: e.user,
    ts: e.ts,
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(material).digest('hex');
}

export class AuditTrail {
  private events: AuditEvent[] = [];

  append(input: {
    action: AuditAction;
    ref: string;
    detail: Record<string, unknown>;
    user: string;
    ts: string;
  }): AuditEvent {
    const prevHash = this.events.length
      ? this.events[this.events.length - 1]!.hash
      : GENESIS;
    const base: Omit<AuditEvent, 'hash'> = {
      seq: this.events.length + 1,
      action: input.action,
      ref: input.ref,
      detail: input.detail,
      user: input.user,
      ts: input.ts,
      prevHash,
    };
    const event: AuditEvent = { ...base, hash: hashEvent(base) };
    this.events.push(event);
    return event;
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }

  /**
   * Verify the entire chain. Returns { valid, brokenAtSeq }. A tampered or
   * reordered event is caught here — the property that makes the trail
   * trustworthy to an external auditor.
   */
  verify(): { valid: boolean; brokenAtSeq?: number } {
    let prev = GENESIS;
    for (const e of this.events) {
      const expected = hashEvent({
        seq: e.seq,
        action: e.action,
        ref: e.ref,
        detail: e.detail,
        user: e.user,
        ts: e.ts,
        prevHash: prev,
      });
      if (e.prevHash !== prev || e.hash !== expected) {
        return { valid: false, brokenAtSeq: e.seq };
      }
      prev = e.hash;
    }
    return { valid: true };
  }

  /** Load persisted events (e.g. from the repository) without re-hashing. */
  hydrate(events: AuditEvent[]): void {
    this.events = [...events];
  }
}
