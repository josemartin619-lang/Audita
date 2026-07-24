/**
 * Bank reconciliation — the daily grind seasoned accountants most want automated.
 * Matches imported bank-statement lines against the ledger's effect on the cash
 * and bank accounts, and surfaces the exceptions (unmatched on either side).
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO, abs } from './money.js';
import { CASH_AND_BANK } from './accounts.js';

const BANK_ACCOUNTS = new Set<string>(CASH_AND_BANK);

export interface StatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  amount: Money; // signed: positive = money into the account, negative = out
}

export interface ReconMatch {
  statement: StatementLine;
  entryId: string;
  entryMemo: string;
}

export interface ReconResult {
  matches: ReconMatch[];
  unmatchedStatement: StatementLine[];
  /** Ledger movements on cash/bank with no corresponding statement line. */
  unmatchedLedger: { entryId: string; date: string; memo: string; delta: Money }[];
  matchedCount: number;
  statementCount: number;
}

/** Net effect of an entry on cash + bank accounts (debit-positive). */
export function bankDelta(e: JournalEntry): Money {
  let d = ZERO;
  for (const l of e.lines) {
    if (BANK_ACCOUNTS.has(l.accountCode)) d += l.debit - l.credit;
  }
  return d;
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime());
  return ms / 86_400_000;
}

/**
 * Greedy match: each statement line pairs with the first unmatched ledger
 * movement of equal amount within `windowDays`. Exact-amount + date-window is
 * the standard first pass; unmatched items on both sides become exceptions.
 */
export function reconcile(
  statement: readonly StatementLine[],
  entries: readonly JournalEntry[],
  windowDays = 5,
): ReconResult {
  const candidates = entries
    .filter((e) => !e.reversed && bankDelta(e) !== ZERO)
    .map((e) => ({ id: e.id, date: e.date, memo: e.memo, delta: bankDelta(e), matched: false }));

  const matches: ReconMatch[] = [];
  const unmatchedStatement: StatementLine[] = [];

  for (const line of statement) {
    const hit = candidates.find(
      (c) => !c.matched && c.delta === line.amount && daysBetween(c.date, line.date) <= windowDays,
    );
    if (hit) {
      hit.matched = true;
      matches.push({ statement: line, entryId: hit.id, entryMemo: hit.memo });
    } else {
      unmatchedStatement.push(line);
    }
  }

  const unmatchedLedger = candidates
    .filter((c) => !c.matched)
    .map((c) => ({ entryId: c.id, date: c.date, memo: c.memo, delta: c.delta }));

  return {
    matches,
    unmatchedStatement,
    unmatchedLedger,
    matchedCount: matches.length,
    statementCount: statement.length,
  };
}

/** Parse a simple CSV/paste: lines of `date,description,amount` (pesos). */
export function parseStatement(text: string, toMoney: (pesos: number) => Money): StatementLine[] {
  const out: StatementLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const date = parts[0]!.trim();
    const amount = Number(parts[parts.length - 1]!.trim().replace(/[^0-9.\-]/g, ''));
    const description = parts.slice(1, -1).join(',').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount)) continue;
    out.push({ date, description, amount: toMoney(amount) });
  }
  return out;
}
