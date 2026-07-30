/**
 * VAT transaction report — the schedule behind the return.
 *
 * A VAT summary that only shows two totals is unauditable: the preparer cannot
 * tie it to anything and the reviewer cannot test it. This module walks every
 * journal entry and reconstructs, line by line, the taxable base, the VAT and
 * the implied rate for each sale and each purchase, so the return total is the
 * sum of a schedule the accountant can read, filter and export.
 *
 * The report is derived from the LEDGER, not from the invoice table — so a
 * manual journal entry that touches output VAT appears here too. That is
 * deliberate: anything that moves the VAT accounts must show up on the return.
 */

import { JournalEntry } from './journal.js';
import { Money, ZERO } from './money.js';
import { ACCT, getAccount, accountExists } from './accounts.js';

export type VatSide = 'sale' | 'purchase';

export interface VatReportLine {
  entryId: string;
  /** Posting date. */
  date: string;
  /** Date on the source document, when it differs from the posting date. */
  docDate: string | null;
  docNumber: string | null;
  counterparty: string;
  memo: string;
  side: VatSide;
  /** Net amount the VAT was computed on. */
  base: Money;
  vat: Money;
  /** Implied rate in basis points, or null when the base is zero. */
  rateBps: number | null;
  /** How the line behaves for VAT: standard, zero_rated or exempt (inferred). */
  treatment: 'standard' | 'zero_rated_or_exempt';
  reversed: boolean;
}

export interface VatRateBand {
  rateBps: number;
  side: VatSide;
  base: Money;
  vat: Money;
  count: number;
}

export interface VatReport {
  from: string;
  to: string;
  sales: VatReportLine[];
  purchases: VatReportLine[];
  bands: VatRateBand[];
  totals: {
    /** Sales that carried VAT. */
    standardSalesBase: Money;
    /** Sales with revenue but no output VAT — zero-rated or exempt. */
    zeroOrExemptSalesBase: Money;
    outputVat: Money;
    purchaseBase: Money;
    inputVat: Money;
    /** Positive = payable to the authority; negative = refundable / credit. */
    netVat: Money;
  };
  /** Entries that move a VAT account but whose base could not be identified. */
  unexplained: { entryId: string; date: string; memo: string; vat: Money; side: VatSide }[];
}

/** Signed movement of one account within a single entry, on its natural side. */
function movement(e: JournalEntry, code: string, natural: 'D' | 'C'): Money {
  let d = ZERO; let c = ZERO;
  for (const l of e.lines) {
    if (l.accountCode !== code) continue;
    d += l.debit; c += l.credit;
  }
  return natural === 'D' ? d - c : c - d;
}

/** Sum of movements across every account of the given types, on their natural side. */
function movementByType(e: JournalEntry, types: readonly string[], exclude: readonly string[]): Money {
  let total = ZERO;
  for (const l of e.lines) {
    if (exclude.includes(l.accountCode)) continue;
    if (!accountExists(l.accountCode)) continue;
    const a = getAccount(l.accountCode);
    if (!types.includes(a.type)) continue;
    total += a.normal === 'D' ? l.debit - l.credit : l.credit - l.debit;
  }
  return total;
}

function impliedRateBps(base: Money, vat: Money): number | null {
  if (base === ZERO) return null;
  // bps, rounded to the nearest whole basis point.
  return Number((vat * 10_000n + base / 2n) / base);
}

const inRange = (date: string, from: string, to: string) => date >= from && date <= to;

export function vatReport(
  entries: readonly JournalEntry[],
  from = '0000-01-01',
  to = '9999-12-31',
): VatReport {
  const sales: VatReportLine[] = [];
  const purchases: VatReportLine[] = [];
  const unexplained: VatReport['unexplained'] = [];

  for (const e of entries) {
    if (!inRange(e.date, from, to)) continue;

    const outputVat = movement(e, ACCT.OUTPUT_VAT, 'C');
    const inputVat = movement(e, ACCT.INPUT_VAT, 'D');
    const revenue = movementByType(e, ['revenue'], []);
    const costs = movementByType(e, ['expense', 'cogs'], []);
    // Capitalised purchases carry recoverable input VAT too, so inventory and
    // fixed assets count towards the purchase base — but never the VAT accounts
    // themselves, and never receivables/cash, which are settlement, not base.
    const capitalised = movementByType(e, ['asset'], [
      ACCT.INPUT_VAT, ACCT.WHT_RECEIVABLE, ACCT.AR, ACCT.CASH, ACCT.BANK,
    ]);

    const base = {
      entryId: e.id, date: e.date, docDate: e.docDate ?? null,
      docNumber: e.sourceDocument ?? null, counterparty: e.source, memo: e.memo,
      reversed: e.reversed,
    };

    // ---- sale side ----
    if (outputVat !== ZERO || revenue !== ZERO) {
      if (revenue !== ZERO) {
        sales.push({
          ...base, side: 'sale', base: revenue, vat: outputVat,
          rateBps: impliedRateBps(revenue, outputVat),
          treatment: outputVat === ZERO ? 'zero_rated_or_exempt' : 'standard',
        });
      } else if (outputVat !== ZERO) {
        unexplained.push({ entryId: e.id, date: e.date, memo: e.memo, vat: outputVat, side: 'sale' });
      }
    }

    // ---- purchase side ----
    if (inputVat !== ZERO) {
      const purchaseBase = costs + capitalised;
      if (purchaseBase !== ZERO) {
        purchases.push({
          ...base, side: 'purchase', base: purchaseBase, vat: inputVat,
          rateBps: impliedRateBps(purchaseBase, inputVat),
          treatment: 'standard',
        });
      } else {
        unexplained.push({ entryId: e.id, date: e.date, memo: e.memo, vat: inputVat, side: 'purchase' });
      }
    }
  }

  const bandMap = new Map<string, VatRateBand>();
  for (const l of [...sales, ...purchases]) {
    const rate = l.rateBps ?? 0;
    const key = `${l.side}:${rate}`;
    const b = bandMap.get(key) ?? { rateBps: rate, side: l.side, base: ZERO, vat: ZERO, count: 0 };
    b.base += l.base; b.vat += l.vat; b.count += 1;
    bandMap.set(key, b);
  }

  const sum = (xs: VatReportLine[], f: (l: VatReportLine) => Money) => xs.reduce((s, l) => s + f(l), ZERO);
  const standardSalesBase = sum(sales.filter((l) => l.treatment === 'standard'), (l) => l.base);
  const zeroOrExemptSalesBase = sum(sales.filter((l) => l.treatment !== 'standard'), (l) => l.base);
  const outputVat = sum(sales, (l) => l.vat) + unexplained.filter((u) => u.side === 'sale').reduce((s, u) => s + u.vat, ZERO);
  const purchaseBase = sum(purchases, (l) => l.base);
  const inputVat = sum(purchases, (l) => l.vat) + unexplained.filter((u) => u.side === 'purchase').reduce((s, u) => s + u.vat, ZERO);

  return {
    from, to, sales, purchases,
    bands: [...bandMap.values()].sort((a, b) => (a.side === b.side ? b.rateBps - a.rateBps : a.side === 'sale' ? -1 : 1)),
    totals: {
      standardSalesBase, zeroOrExemptSalesBase, outputVat,
      purchaseBase, inputVat, netVat: outputVat - inputVat,
    },
    unexplained,
  };
}
