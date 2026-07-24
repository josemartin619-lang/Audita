/**
 * Continuous control rules. Each rule is a PURE function of an entry (plus
 * context) returning zero or more findings-in-waiting. Determinism and
 * explainability are requirements: an auditor must be able to see exactly why
 * something was flagged. No black boxes.
 */

import { JournalEntry, entryAmount } from '../journal.js';
import { Money, abs, formatCOP } from '../money.js';
import { Severity } from '../findings.js';
import { ACCT } from '../accounts.js';

export interface RuleHit {
  rule: string;
  severity: Severity;
  entryId: string;
  message: string;
}

export interface RuleContext {
  /** All previously posted (non-reversed) entries, for cross-entry rules. */
  priorEntries: readonly JournalEntry[];
  /** Approval threshold used by threshold/round rules (minor units). */
  approvalThreshold: Money;
  /** Invoice numbers already issued, for sequence-gap detection. */
  issuedInvoiceNumbers?: readonly string[];
  /** Related-party names/IDs to watch (conflict-of-interest / transfer pricing). */
  relatedParties?: readonly string[];
}

type Rule = (e: JournalEntry, ctx: RuleContext) => RuleHit[];

const dayOfWeek = (iso: string): number =>
  new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat

/** 1. Postings dated on a weekend — unusual, verify supporting document. */
const weekendPosting: Rule = (e) => {
  const d = dayOfWeek(e.date);
  if (d === 0 || d === 6) {
    return [{
      rule: 'Weekend posting',
      severity: 'medium',
      entryId: e.id,
      message: `Entry dated ${e.date} (${d === 0 ? 'Sunday' : 'Saturday'}). Review supporting document.`,
    }];
  }
  return [];
};

/** 2. Large, perfectly round amounts — often manual estimates or adjustments. */
const roundAmount: Rule = (e) => {
  const amt = entryAmount(e);
  // >= 1,000,000 (100,000,000 minor units) and a multiple of 100,000
  if (amt >= 100_000_000n && amt % 10_000_000n === 0n) {
    return [{
      rule: 'Unusual round amount',
      severity: 'medium',
      entryId: e.id,
      message: `Exact value ${formatCOP(amt)}, no cents. Possible estimate or manual adjustment.`,
    }];
  }
  return [];
};

/** 3. Amount just under an approval threshold — possible structuring. */
const underThreshold: Rule = (e, ctx) => {
  const amt = entryAmount(e);
  const floor = (ctx.approvalThreshold * 90n) / 100n; // within 10% below
  if (amt >= floor && amt < ctx.approvalThreshold) {
    return [{
      rule: 'Amount just under approval threshold',
      severity: 'high',
      entryId: e.id,
      message: `Value ${formatCOP(amt)} sits just below the approval threshold ${formatCOP(ctx.approvalThreshold)}. Possible transaction splitting.`,
    }];
  }
  return [];
};

/** 4. Duplicate: same source, same date, same amount as a prior entry. */
const duplicate: Rule = (e, ctx) => {
  const amt = entryAmount(e);
  const dup = ctx.priorEntries.find(
    (x) => x.id !== e.id && x.source === e.source && x.date === e.date && entryAmount(x) === amt,
  );
  if (dup) {
    return [{
      rule: 'Possible duplicate',
      severity: 'high',
      entryId: e.id,
      message: `Same value ${formatCOP(amt)}, same date and counterparty as ${dup.id}. Check for a double posting.`,
    }];
  }
  return [];
};

/**
 * 5. Benford first-digit deviation on a single large expense. A soft signal:
 *    entries whose leading digit is 9 among round-ish large values get a low
 *    flag. (Real Benford analysis runs over a population; here we keep it
 *    explainable and per-entry, escalate in period analysis.)
 */
const benfordLeadingDigit: Rule = (e) => {
  const amt = entryAmount(e);
  if (amt < 50_000_000n) return []; // only meaningful for larger values
  const firstDigit = Number(abs(amt).toString()[0]);
  if (firstDigit === 9) {
    return [{
      rule: 'Atypical leading digit (Benford)',
      severity: 'low',
      entryId: e.id,
      message: `Value ${formatCOP(amt)} starts with 9; low frequency under Benford's law. Weak signal, correlate across the period.`,
    }];
  }
  return [];
};

/** 6. Manual adjustment to a cash/bank account — higher scrutiny. */
const manualCashAdjustment: Rule = (e) => {
  const touchesCash = e.lines.some((l) => l.accountCode === ACCT.CASH || l.accountCode === ACCT.BANK);
  const looksManual = /adjust|manual/i.test(`${e.memo} ${e.source}`);
  if (touchesCash && looksManual) {
    return [{
      rule: 'Manual cash/bank adjustment',
      severity: 'medium',
      entryId: e.id,
      message: `Manual movement on cash/bank: "${e.memo}". Requires supporting document and approval.`,
    }];
  }
  return [];
};

/** 7. Related-party transaction — counterparty on the watchlist. */
const relatedParty: Rule = (e, ctx) => {
  const watch = ctx.relatedParties ?? [];
  const hit = watch.find((w) => e.source.toLowerCase().includes(w.toLowerCase()));
  if (hit) {
    return [{
      rule: 'Related-party transaction',
      severity: 'medium',
      entryId: e.id,
      message: `Counterparty "${e.source}" is on the related-parties list. Verify arm's-length value and disclosure (IFRS / transfer pricing).`,
    }];
  }
  return [];
};

export const PER_ENTRY_RULES: Rule[] = [
  weekendPosting,
  roundAmount,
  underThreshold,
  duplicate,
  benfordLeadingDigit,
  manualCashAdjustment,
  relatedParty,
];

/** Cross-entry: detect gaps in the invoice consecutive numbering (ZATCA). */
export function invoiceSequenceGaps(numbers: readonly string[]): RuleHit[] {
  const parsed = numbers
    .map((n) => ({ n, seq: parseInt(n.split('-')[1] ?? '', 10) }))
    .filter((x) => Number.isFinite(x.seq))
    .sort((a, b) => a.seq - b.seq);
  const hits: RuleHit[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const gap = parsed[i]!.seq - parsed[i - 1]!.seq;
    if (gap > 1) {
      for (let missing = parsed[i - 1]!.seq + 1; missing < parsed[i]!.seq; missing++) {
        const code = `FE-${String(missing).padStart(4, '0')}`;
        hits.push({
          rule: 'Numbering gap',
          severity: 'medium',
          entryId: '—',
          message: `Invoice ${code} is missing from the issued sequence. ZATCA requires continuous numbering (ICV / PIH chain).`,
        });
      }
    }
  }
  return hits;
}

export function runPerEntryRules(e: JournalEntry, ctx: RuleContext): RuleHit[] {
  return PER_ENTRY_RULES.flatMap((rule) => rule(e, ctx));
}
