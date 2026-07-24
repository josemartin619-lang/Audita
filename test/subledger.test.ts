import { describe, it, expect } from 'vitest';
import { pesos } from '../src/domain/money.js';
import { aging, outstanding, daysOverdue, type OpenItem } from '../src/domain/subledger.js';

const mk = (over: Partial<OpenItem>): OpenItem => ({
  id: 'X', kind: 'receivable', contactId: 'c', contactName: 'C', docNumber: 'FE-1',
  date: '2026-05-01', dueDate: '2026-05-31', original: pesos(1_000_000), paid: pesos(0), entryId: 'AS-1',
  ...over,
});

describe('AR/AP subledger', () => {
  it('computes outstanding as original minus paid', () => {
    expect(outstanding(mk({ original: pesos(1_000_000), paid: pesos(400_000) }))).toBe(pesos(600_000));
  });

  it('computes days overdue', () => {
    expect(daysOverdue('2026-06-01', '2026-06-16')).toBe(15);
    expect(daysOverdue('2026-06-30', '2026-06-16')).toBeLessThan(0); // not yet due
  });

  it('buckets receivables by age and sums the total', () => {
    const asOf = '2026-07-01';
    const items = [
      mk({ id: 'A', dueDate: '2026-07-15', original: pesos(500_000) }),   // not due -> current
      mk({ id: 'B', dueDate: '2026-06-20', original: pesos(300_000) }),   // 11 days -> 1-30
      mk({ id: 'C', dueDate: '2026-05-15', original: pesos(200_000) }),   // 47 days -> 31-60
      mk({ id: 'D', dueDate: '2026-03-01', original: pesos(100_000) }),   // >90 -> 90+
      mk({ id: 'E', dueDate: '2026-06-01', original: pesos(400_000), paid: pesos(400_000) }), // fully paid -> excluded
    ];
    const a = aging(items, 'receivable', asOf);
    expect(a.buckets.current).toBe(pesos(500_000));
    expect(a.buckets.d1_30).toBe(pesos(300_000));
    expect(a.buckets.d31_60).toBe(pesos(200_000));
    expect(a.buckets.d90plus).toBe(pesos(100_000));
    expect(a.total).toBe(pesos(1_100_000)); // paid item excluded
    expect(a.rows.length).toBe(4);
    // sorted most-overdue first
    expect(a.rows[0]!.item.id).toBe('D');
  });

  it('separates receivables from payables', () => {
    const items = [
      mk({ id: 'R', kind: 'receivable', original: pesos(100) }),
      mk({ id: 'P', kind: 'payable', original: pesos(200) }),
    ];
    expect(aging(items, 'receivable', '2026-07-01').total).toBe(pesos(100));
    expect(aging(items, 'payable', '2026-07-01').total).toBe(pesos(200));
  });
});
