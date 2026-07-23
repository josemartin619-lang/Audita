/**
 * Journal entries — the atomic unit of the ledger. Every entry is a balanced
 * double-entry transaction. An entry that does not balance cannot be built.
 */

import { Money, ZERO, abs } from './money.js';
import { Jurisdiction } from './jurisdiction.js';
import { COLOMBIA } from './jurisdictions/colombia.js';

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
    super(`El asiento no cuadra: débitos=${debit} créditos=${credit}`);
    this.name = 'UnbalancedEntryError';
  }
}

/**
 * Validate and normalize a draft into JournalLines. Throws if:
 *  - a line references an account unknown to the active jurisdiction's chart,
 *  - a line has both debit and credit, or negative values,
 *  - the entry does not balance to zero.
 */
export function normalizeLines(draft: DraftLine[], jurisdiction: Jurisdiction = COLOMBIA): JournalLine[] {
  if (draft.length < 2) {
    throw new Error('Un asiento de partida doble requiere al menos 2 líneas.');
  }
  const knownCodes = new Set(jurisdiction.chart.map((a) => a.code));
  const lines: JournalLine[] = draft.map((l) => {
    const debit = l.debit ?? ZERO;
    const credit = l.credit ?? ZERO;
    if (!knownCodes.has(l.accountCode)) {
      throw new Error(`Cuenta desconocida: ${l.accountCode}`);
    }
    if (debit < ZERO || credit < ZERO) {
      throw new Error(`Débito y crédito no pueden ser negativos (${l.accountCode}).`);
    }
    if (debit > ZERO && credit > ZERO) {
      throw new Error(`Una línea no puede tener débito y crédito a la vez (${l.accountCode}).`);
    }
    if (debit === ZERO && credit === ZERO) {
      throw new Error(`Una línea debe tener débito o crédito (${l.accountCode}).`);
    }
    return { accountCode: l.accountCode, debit, credit };
  });

  const d = totalDebit(lines);
  const c = totalCredit(lines);
  if (d !== c) throw new UnbalancedEntryError(d, c);
  if (abs(d) === ZERO) throw new Error('El asiento no puede ser por valor cero.');
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
