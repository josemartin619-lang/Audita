/**
 * Population-level control analytics — run over a whole period, not per entry.
 * These complement the per-entry rules: some patterns (Benford deviation,
 * posting velocity) only appear across many transactions.
 */

import { JournalEntry, entryAmount } from '../journal.js';
import { Money, abs } from '../money.js';
import { RuleHit } from './rules.js';

/** Expected first-digit frequencies under Benford's law (digits 1..9). */
export const BENFORD_EXPECTED: readonly number[] = [
  0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046,
];

export interface BenfordResult {
  n: number;
  observed: number[]; // index 0 => digit 1 ... index 8 => digit 9
  expected: number[];
  /** Chi-square statistic of observed vs expected. */
  chiSquare: number;
  /** True if deviation exceeds the 8-dof 95% critical value (15.51). */
  anomalous: boolean;
}

function firstDigit(m: Money): number {
  const s = abs(m).toString().replace(/^0+/, '');
  return s.length ? Number(s[0]) : 0;
}

/**
 * Benford analysis over entry amounts. Meaningful only with enough data; with
 * fewer than 30 entries we report but never flag as anomalous.
 */
export function benfordAnalysis(entries: readonly JournalEntry[]): BenfordResult {
  const counts = new Array(9).fill(0);
  let n = 0;
  for (const e of entries) {
    if (e.reversed) continue;
    const d = firstDigit(entryAmount(e));
    if (d >= 1 && d <= 9) {
      counts[d - 1] += 1;
      n += 1;
    }
  }
  const observed = counts.map((c) => (n ? c / n : 0));
  let chiSquare = 0;
  if (n > 0) {
    for (let i = 0; i < 9; i++) {
      const expectedCount = BENFORD_EXPECTED[i]! * n;
      chiSquare += ((counts[i] - expectedCount) ** 2) / expectedCount;
    }
  }
  return {
    n,
    observed,
    expected: [...BENFORD_EXPECTED],
    chiSquare,
    anomalous: n >= 30 && chiSquare > 15.51, // χ²(8, .95)
  };
}

/**
 * Posting velocity — flag any source that posts more than `maxPerDay` entries
 * on the same date (bunching / possible structuring or automation error).
 */
export function velocityAnalysis(
  entries: readonly JournalEntry[],
  maxPerDay = 3,
): RuleHit[] {
  const byKey = new Map<string, number>();
  for (const e of entries) {
    if (e.reversed) continue;
    const key = `${e.source}|${e.date}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const hits: RuleHit[] = [];
  for (const [key, count] of byKey) {
    if (count > maxPerDay) {
      const [source, date] = key.split('|');
      hits.push({
        rule: 'Unusual posting velocity',
        severity: 'medium',
        entryId: '—',
        message: `${count} entries from "${source}" on the same day (${date}). Possible bunching or automation error.`,
      });
    }
  }
  return hits;
}
