/**
 * Jurisdiction — the seam that keeps the domain from hardcoding one
 * country's chart of accounts, tax rules, currency, and e-invoicing regime.
 *
 * Before this file existed, the account codes ('111005', '413505', ...), the
 * VAT rate (1900 bps), the currency formatting (COP-style grouping), and the
 * DIAN CUFE provider were hardcoded directly inside reports.ts, taxReport.ts,
 * controls/rules.ts, invoiceService.ts and firmWorkspace.ts. That was fine
 * when Colombia was the only market. It stops being fine the moment a second
 * jurisdiction (Saudi Arabia) needs to exist, because every one of those
 * hardcodes is a Colombia assumption baked into "the domain."
 *
 * This interface is that config, extracted. The domain logic itself (
 * double-entry balancing, the hash-chained audit trail, continuous controls)
 * does NOT change per jurisdiction — only the values in this object do.
 *
 * `jurisdictions/colombia.ts` is jurisdiction one: the original, fully-tested
 * product, relocated into this shape with no behavior change. It is the
 * proof that this seam is real, not aspirational — the whole abstraction is
 * extracted FROM working code, not designed in the abstract and hoped onto it.
 */

import type { Account } from './accounts.js';
import type { Money } from './money.js';
import type { EInvoicingProvider } from '../einvoicing/provider.js';

/**
 * Semantic account roles the domain code needs, independent of which
 * country's chart is active. Every jurisdiction must map each key to exactly
 * one account code in its own chart. Domain/service code should reference
 * `jurisdiction.accounts.REVENUE` etc., never a raw code literal.
 */
export type AcctKey =
  | 'CASH'
  | 'BANK'
  | 'ACCOUNTS_RECEIVABLE'
  | 'INPUT_VAT'
  | 'INVENTORY'
  | 'ACCOUNTS_PAYABLE'
  | 'OUTPUT_VAT'
  | 'WITHHOLDING'
  | 'EQUITY'
  | 'REVENUE'
  | 'ADMIN_EXPENSE'
  | 'SELLING_EXPENSE'
  | 'COGS';

/** Minimal client identity needed to construct a provider for one client. */
export interface JurisdictionClientMeta {
  clientId: string;
  name: string;
  ofeNit: string;
}

export interface JurisdictionCurrency {
  /** Display code, e.g. 'COP', 'SAR'. */
  code: string;
  /** Format minor units (centavos/halalas) as a display string. */
  format(minor: Money, withCents?: boolean): string;
  /** Minor units -> a JSON-safe major-unit number (reports/UI only, never math). */
  toMajorNumber(minor: Money): number;
  /** Major-unit number (e.g. 1234.56) -> minor units, rounding at the boundary. */
  fromMajorNumber(amount: number): Money;
}

export interface JurisdictionTax {
  /** Standard VAT/IVA rate in basis points (1% = 100 bps). */
  vatStandardBps: number;
  withholding:
    | { enabled: true; defaultBps: number }
    | { enabled: false };
}

export interface Jurisdiction {
  /** Short stable id, e.g. 'COL', 'KSA'. Used as a tenant/config key, not shown to users. */
  id: string;
  name: string;
  defaultLocale: 'en' | 'es' | 'ar';
  chart: readonly Account[];
  accounts: Record<AcctKey, string>;
  currency: JurisdictionCurrency;
  tax: JurisdictionTax;
  /** Prefix used for generated invoice numbers, e.g. 'FE' -> FE-0001. */
  invoiceNumberPrefix: string;
  makeProvider(meta: JurisdictionClientMeta): EInvoicingProvider;
  /** Compliance message for a missing invoice-sequence number (jurisdiction-specific wording/regulator). */
  sequenceGapMessage(missingNumber: string): string;
}

/** Look up an account's definition (incl. normal debit/credit side) within a specific jurisdiction's chart. */
export function resolveAccount(jurisdiction: Jurisdiction, code: string): Account {
  const account = jurisdiction.chart.find((a) => a.code === code);
  if (!account) {
    throw new Error(`Unknown account in ${jurisdiction.id} chart: ${code}`);
  }
  return account;
}
