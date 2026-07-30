/**
 * Journal entries — the atomic unit of the ledger. Every entry is a balanced
 * double-entry transaction. An entry that does not balance cannot be built.
 */

import { Money, ZERO, abs } from './money.js';
import { accountExists } from './accounts.js';

export interface JournalLine {
  accountCode: string;
  /** debit and credit are non-negative; exactly one is > 0 per line (by convention). */
  debit: Money;
  credit: Money;
}

export interface JournalEntry {
  id: string;
  /** ISO date (YYYY-MM-DD) of the accounting event. */
  date: string;
  memo: string;
  /** Counterparty / origin — used by controls (duplicates) and risk scoring. */
  source: string;
  user: string;
  lines: JournalLine[];
  /** True once superseded by a reversing entry. The original is never deleted. */
  reversed: boolean;
  /** ISO timestamp the entry was recorded. */
  recordedAt: string;
  /** Optional link back to a source document (invoice number, etc.). */
  sourceDocument?: string;
  /** Date printed on the source document, when it differs from the posting date. */
  docDate?: string;
}

export interface DraftLine {
  accountCode: string;
  debit?: Money;
  credit?: Money;
}

export interface DraftEntry {
  date: string;
  memo: string;
  source: string;
  user: string;
  lines: DraftLine[];
  sourceDocument?: string;
  docDate?: string;
}

export function totalDebit(lines: { debit: Money }[]): Money {
  return lines.reduce((s, l) => s + l.debit, ZERO);
}
export function totalCredit(lines: { credit: Money }[]): Money {
  return lines.reduce((s, l) => s + l.credit, ZERO);
}

/** Amount of an entry = its total debit (== total credit for a valid entry). */
export function entryAmount(e: JournalEntry): Money {
  return totalDebit(e.lines);
}

export class UnbalancedEntryError extends Error {
  constructor(public debit: Money, public credit: Money) {
    super(
      `Entry is out of balance: total debits ${debit} vs total credits ${credit}. ` +
        'Every entry must have debits equal to credits.',
    );
    this.name = 'UnbalancedEntryError';
  }
}

/**
 * Validate and normalize a draft into JournalLines. Throws if:
 *  - a line references an unknown account,
 *  - a line has both debit and credit, or negative values,
 *  - the entry does not balance to zero.
 */
export function normalizeLines(draft: DraftLine[]): JournalLine[] {
  if (draft.length < 2) {
    throw new Error('A double-entry needs at least 2 lines — one debit and one credit.');
  }
  const lines: JournalLine[] = draft.map((l) => {
    const debit = l.debit ?? ZERO;
    const credit = l.credit ?? ZERO;
    if (!accountExists(l.accountCode)) {
      throw new Error(`Unknown account code: ${l.accountCode}. Pick an account from the list.`);
    }
    if (debit < ZERO || credit < ZERO) {
      throw new Error(
        `Account ${l.accountCode}: debit and credit cannot be negative. ` +
          'To decrease an account, put the amount on the opposite side.',
      );
    }
    if (debit > ZERO && credit > ZERO) {
      throw new Error(
        `Account ${l.accountCode}: a line cannot have both a debit and a credit. ` +
          'Split it into two lines.',
      );
    }
    if (debit === ZERO && credit === ZERO) {
      throw new Error(`Account ${l.accountCode}: enter an amount in either the debit or the credit column.`);
    }
    return { accountCode: l.accountCode, debit, credit };
  });

  const d = totalDebit(lines);
  const c = totalCredit(lines);
  if (d !== c) throw new UnbalancedEntryError(d, c);
  if (abs(d) === ZERO) throw new Error('An entry cannot be for zero — enter the amounts.');
  return lines;
}

/** Build the reversing lines for an entry (debits<->credits swapped). */
export function reversingLines(e: JournalEntry): JournalLine[] {
  return e.lines.map((l) => ({
    accountCode: l.accountCode,
    debit: l.credit,
    credit: l.debit,
  }));
}
