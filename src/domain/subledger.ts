/**
 * AR/AP subledger — tracks who owes whom. Each open item is a receivable
 * (customer owes us) or a payable (we owe a vendor), carrying its original
 * amount and how much has been paid. The ledger records the postings; this
 * subledger is the materialized view of outstanding balances and aging.
 */

import { Money, ZERO } from './money.js';

export type OpenItemKind = 'receivable' | 'payable';

export interface Contact {
  id: string;
  name: string;
  nit: string;
  kind: 'customer' | 'vendor' | 'both';
}

export interface OpenItem {
  id: string;
  kind: OpenItemKind;
  contactId: string;
  contactName: string;
  docNumber: string;
  date: string;      // issue date YYYY-MM-DD
  dueDate: string;   // due date YYYY-MM-DD
  original: Money;
  paid: Money;
  entryId: string;   // the journal entry that created it (provenance)
}

export function outstanding(i: OpenItem): Money {
  return i.original - i.paid;
}
export function isOpen(i: OpenItem): boolean {
  return outstanding(i) > ZERO;
}

export function daysOverdue(dueDate: string, asOf: string): number {
  const ms = new Date(`${asOf}T12:00:00Z`).getTime() - new Date(`${dueDate}T12:00:00Z`).getTime();
  return Math.floor(ms / 86_400_000);
}

export interface AgingRow {
  item: OpenItem;
  outstanding: Money;
  daysOverdue: number;
  bucket: 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';
}

export interface Aging {
  kind: OpenItemKind;
  asOf: string;
  buckets: Record<'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus', Money>;
  total: Money;
  rows: AgingRow[];
}

function bucketFor(days: number): AgingRow['bucket'] {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90plus';
}

/** Age the open items of one kind as of a date. Only items with a balance count. */
export function aging(items: readonly OpenItem[], kind: OpenItemKind, asOf: string): Aging {
  const buckets = { current: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90plus: ZERO } as Aging['buckets'];
  let total = ZERO;
  const rows: AgingRow[] = [];
  for (const item of items) {
    if (item.kind !== kind) continue;
    const bal = outstanding(item);
    if (bal <= ZERO) continue;
    const days = daysOverdue(item.dueDate, asOf);
    const bucket = bucketFor(days);
    buckets[bucket] += bal;
    total += bal;
    rows.push({ item, outstanding: bal, daysOverdue: days, bucket });
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { kind, asOf, buckets, total, rows };
}
