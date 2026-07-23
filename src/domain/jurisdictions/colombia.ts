/**
 * Colombia — jurisdiction one.
 *
 * This is the original Audita core (v0.2, "Phase 0 foundation"), relocated
 * behind the Jurisdiction seam with NO behavior change: the same PUC chart,
 * the same 19% IVA / 2.5% retefuente, the same DIAN sandbox provider, the
 * same Spanish control and compliance messages. Every value here was
 * previously a constant scattered across domain/services; this file is now
 * the single place they live.
 *
 * This stays in the tree as a real, working, tested jurisdiction — not
 * deleted, not "residue" to clean up. It is what proves the Jurisdiction
 * abstraction generalizes once a second real jurisdiction (Saudi Arabia) is
 * built alongside it.
 */

import { CHART_OF_ACCOUNTS } from '../accounts.js';
import { formatCOP, toPesosNumber, pesos } from '../money.js';
import { SandboxEInvoicingProvider } from '../../einvoicing/sandboxProvider.js';
import type { Jurisdiction } from '../jurisdiction.js';

export const COLOMBIA: Jurisdiction = {
  id: 'COL',
  name: 'Colombia',
  defaultLocale: 'es',
  chart: CHART_OF_ACCOUNTS,
  accounts: {
    CASH: '110505',
    BANK: '111005',
    ACCOUNTS_RECEIVABLE: '130505',
    INPUT_VAT: '135515',
    INVENTORY: '143505',
    ACCOUNTS_PAYABLE: '220505',
    OUTPUT_VAT: '240805',
    WITHHOLDING: '236540',
    EQUITY: '310505',
    REVENUE: '413505',
    ADMIN_EXPENSE: '513505',
    SELLING_EXPENSE: '523505',
    COGS: '613505',
  },
  currency: {
    code: 'COP',
    format: formatCOP,
    toMajorNumber: toPesosNumber,
    fromMajorNumber: pesos,
  },
  tax: {
    vatStandardBps: 1900, // 19% IVA
    withholding: { enabled: true, defaultBps: 250 }, // 2.5% retefuente (demo default)
  },
  invoiceNumberPrefix: 'FE',
  makeProvider: () => new SandboxEInvoicingProvider(),
  sequenceGapMessage: (code) =>
    `Falta el consecutivo ${code} en la numeración emitida. DIAN exige numeración continua.`,
};
