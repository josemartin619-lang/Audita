/**
 * Financial reports — all computed from the journal. The trial balance summing
 * to zero is the system's continuous invariant.
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO } from './money.js';
import { Account, CHART_OF_ACCOUNTS, getAccount, ACCT, CASH_AND_BANK } from './accounts.js';

export interface AccountBalance {
  account: Account;
  /** Signed debit-positive raw balance (sum of debits - credits). */
  raw: Money;
  /** Natural positive balance in the account's normal side. */
  natural: Money;
}

/** Debit-positive raw balances per account code. */
export function rawBalances(entries: readonly JournalEntry[]): Map<string, Money> {
  const b = new Map<string, Money>();
  for (const a of CHART_OF_ACCOUNTS) b.set(a.code, ZERO);
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

export function naturalBalance(code: string, entries: readonly JournalEntry[]): Money {
  const raw = rawBalances(entries).get(code) ?? ZERO;
  return getAccount(code).normal === 'D' ? raw : -raw;
}

export interface TrialBalance {
  rows: { code: string; name: string; debit: Money; credit: Money }[];
  totalDebit: Money;
  totalCredit: Money;
  balanced: boolean;
}

export function trialBalance(entries: readonly JournalEntry[]): TrialBalance {
  const raw = rawBalances(entries);
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows = CHART_OF_ACCOUNTS.map((a) => {
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

export function incomeStatement(entries: readonly JournalEntry[]): IncomeStatement {
  const nat = (code: string) => naturalBalance(code, entries);
  const ingresos = nat(ACCT.REVENUE);
  const costo = nat(ACCT.COGS);
  const gastos = nat(ACCT.ADMIN_EXP) + nat(ACCT.SELLING_EXP);
  return { ingresos, costo, gastos, utilidad: ingresos - costo - gastos };
}

export interface ProvenanceLine {
  entryId: string;
  date: string;
  memo: string;
  source: string;
  reversed: boolean;
  debit: Money;
  credit: Money;
  /** Signed contribution to the account in its NATURAL direction. */
  contribution: Money;
}

export interface AccountProvenance {
  code: string;
  name: string;
  natural: Money;
  lines: ProvenanceLine[];
}

/**
 * "Prove this number." Returns every entry that contributes to an account's
 * balance, with the exact debit/credit it posted — so any figure on a statement
 * can be traced to its source transactions (and, upstream, to their evidence
 * hashes and control findings).
 */
export function accountProvenance(
  code: string,
  entries: readonly JournalEntry[],
): AccountProvenance {
  const account = getAccount(code);
  const sign = account.normal === 'D' ? 1n : -1n;
  const lines: ProvenanceLine[] = [];
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.accountCode !== code) continue;
      lines.push({
        entryId: e.id,
        date: e.date,
        memo: e.memo,
        source: e.source,
        reversed: e.reversed,
        debit: l.debit,
        credit: l.credit,
        contribution: sign * (l.debit - l.credit),
      });
    }
  }
  return { code, name: account.name, natural: naturalBalance(code, entries), lines };
}

export interface BalanceSheet {
  activos: Money;
  pasivos: Money;
  patrimonio: Money;
  cuadra: boolean;
}

const CASH_ACCOUNTS = new Set<string>(CASH_AND_BANK);

/** Classify a non-cash account into a cash-flow activity (IFRS codes). */
function cashFlowActivity(code: string): 'operating' | 'investing' | 'financing' {
  if (code === ACCT.CAPITAL) return 'financing';       // equity contributions
  if (code === ACCT.PPE) return 'investing';           // property, plant & equipment
  return 'operating';
}

export interface CashFlowStatement {
  operating: Money;
  investing: Money;
  financing: Money;
  netChange: Money;
  openingCash: Money;
  closingCash: Money;
  reconciles: boolean;
}

/**
 * Statement of cash flows (direct-ish): for every entry that moves cash, the
 * non-cash offsets explain WHY, and each is classified into operating /
 * investing / financing. The three activities sum to the net change in cash,
 * which must reconcile to closing − opening cash.
 */
export function cashFlowStatement(entries: readonly JournalEntry[]): CashFlowStatement {
  let operating = ZERO, investing = ZERO, financing = ZERO;
  for (const e of entries) {
    if (e.reversed) continue;
    if (!e.lines.some((l) => CASH_ACCOUNTS.has(l.accountCode))) continue;
    for (const l of e.lines) {
      if (CASH_ACCOUNTS.has(l.accountCode)) continue;
      // A non-cash line's contribution to cash = credit − debit.
      const contribution = l.credit - l.debit;
      const act = cashFlowActivity(l.accountCode);
      if (act === 'financing') financing += contribution;
      else if (act === 'investing') investing += contribution;
      else operating += contribution;
    }
  }
  const netChange = operating + investing + financing;
  const closingCash =
    naturalBalance(ACCT.CASH, entries) + naturalBalance(ACCT.BANK, entries);
  const openingCash = closingCash - netChange;
  return {
    operating, investing, financing, netChange, openingCash, closingCash,
    reconciles: openingCash + netChange === closingCash,
  };
}

export function balanceSheet(entries: readonly JournalEntry[]): BalanceSheet {
  const nat = (code: string) => naturalBalance(code, entries);
  const activos =
    nat(ACCT.CASH) + nat(ACCT.BANK) + nat(ACCT.AR) + nat(ACCT.INPUT_VAT) + nat(ACCT.WHT_RECEIVABLE) + nat(ACCT.INVENTORY) + nat(ACCT.PPE);
  const pasivos = nat(ACCT.AP) + nat(ACCT.OUTPUT_VAT) + nat(ACCT.WHT_PAYABLE);
  const patrimonio = nat(ACCT.CAPITAL) + incomeStatement(entries).utilidad;
  return {
    activos,
    pasivos,
    patrimonio,
    cuadra: activos === pasivos + patrimonio,
  };
}
