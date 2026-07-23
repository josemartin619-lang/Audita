/**
 * Financial reports — all computed from the journal. The trial balance summing
 * to zero is the system's continuous invariant.
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO } from './money.js';
import { Account } from './accounts.js';
import { Jurisdiction, resolveAccount } from './jurisdiction.js';
import { COLOMBIA } from './jurisdictions/colombia.js';

export interface AccountBalance {
  account: Account;
  /** Signed debit-positive raw balance (sum of debits - credits). */
  raw: Money;
  /** Natural positive balance in the account's normal side. */
  natural: Money;
}

/** Debit-positive raw balances per account code. */
export function rawBalances(
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): Map<string, Money> {
  const b = new Map<string, Money>();
  for (const a of jurisdiction.chart) b.set(a.code, ZERO);
  // NOTE: reversed entries are NOT skipped. A reversal is a real, opposite
  // entry that cancels the original; both remain in the balances and net to
  // zero. The `reversed` flag is a status marker (and prevents re-reversal),
  // not a balance filter — skipping here would double-count the cancellation.
  for (const e of entries) {
    for (const l of e.lines) {
      b.set(l.accountCode, (b.get(l.accountCode) ?? ZERO) + l.debit - l.credit);
    }
  }
  return b;
}

export function naturalBalance(
  code: string,
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): Money {
  const raw = rawBalances(entries, jurisdiction).get(code) ?? ZERO;
  return resolveAccount(jurisdiction, code).normal === 'D' ? raw : -raw;
}

export interface TrialBalance {
  rows: { code: string; name: string; debit: Money; credit: Money }[];
  totalDebit: Money;
  totalCredit: Money;
  balanced: boolean;
}

export function trialBalance(
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): TrialBalance {
  const raw = rawBalances(entries, jurisdiction);
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows = jurisdiction.chart.map((a) => {
    const v = raw.get(a.code) ?? ZERO;
    const debit = v > ZERO ? v : ZERO;
    const credit = v < ZERO ? -v : ZERO;
    totalDebit += debit;
    totalCredit += credit;
    return { code: a.code, name: a.name, debit, credit };
  }).filter((r) => r.debit !== ZERO || r.credit !== ZERO);
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export interface IncomeStatement {
  ingresos: Money;
  costo: Money;
  gastos: Money;
  utilidad: Money;
}

export function incomeStatement(
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): IncomeStatement {
  const acct = jurisdiction.accounts;
  const nat = (code: string) => naturalBalance(code, entries, jurisdiction);
  const ingresos = nat(acct.REVENUE);
  const costo = nat(acct.COGS);
  const gastos = nat(acct.ADMIN_EXPENSE) + nat(acct.SELLING_EXPENSE);
  return { ingresos, costo, gastos, utilidad: ingresos - costo - gastos };
}

export interface BalanceSheet {
  activos: Money;
  pasivos: Money;
  patrimonio: Money;
  cuadra: boolean;
}

export function balanceSheet(
  entries: readonly JournalEntry[],
  jurisdiction: Jurisdiction = COLOMBIA,
): BalanceSheet {
  const acct = jurisdiction.accounts;
  const nat = (code: string) => naturalBalance(code, entries, jurisdiction);
  const activos =
    nat(acct.CASH) + nat(acct.BANK) + nat(acct.ACCOUNTS_RECEIVABLE) + nat(acct.INPUT_VAT) + nat(acct.INVENTORY);
  const pasivos = nat(acct.ACCOUNTS_PAYABLE) + nat(acct.OUTPUT_VAT) + nat(acct.WITHHOLDING);
  const patrimonio = nat(acct.EQUITY) + incomeStatement(entries, jurisdiction).utilidad;
  return {
    activos,
    pasivos,
    patrimonio,
    cuadra: activos === pasivos + patrimonio,
  };
}
