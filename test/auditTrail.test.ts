import { describe, it, expect } from 'vitest';
import { AuditTrail } from '../src/domain/auditTrail.js';

function build() {
  const t = new AuditTrail();
  t.append({ action: 'POST_ENTRY', ref: 'AS-0001', detail: { amount: '100' }, user: 'u', ts: '2026-06-01T00:00:00Z' });
  t.append({ action: 'POST_ENTRY', ref: 'AS-0002', detail: { amount: '200' }, user: 'u', ts: '2026-06-02T00:00:00Z' });
  t.append({ action: 'ISSUE_INVOICE', ref: 'FE-0001', detail: { cufe: 'abc' }, user: 'u', ts: '2026-06-02T00:00:01Z' });
  return t;
}

describe('immutable hash-chained audit trail', () => {
  it('links each event to the previous hash', () => {
    const t = build();
    const events = t.all();
    expect(events[0]!.prevHash).toBe('GENESIS');
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    expect(events[2]!.prevHash).toBe(events[1]!.hash);
  });

  it('verifies a well-formed chain', () => {
    expect(build().verify()).toEqual({ valid: true });
  });

  it('detects tampering with a historical event', () => {
    const t = build();
    // Simulate someone altering a stored event's detail after the fact.
    (t.all() as any)[1].detail = { amount: '999999' };
    const res = t.verify();
    expect(res.valid).toBe(false);
    expect(res.brokenAtSeq).toBe(2);
  });

  it('detects reordering / deletion (chain break)', () => {
    const t = build();
    const events = t.all() as any[];
    // drop the middle event
    events.splice(1, 1);
    (t as any).events = events;
    expect(t.verify().valid).toBe(false);
  });
});
