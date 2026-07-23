import { describe, it, expect } from 'vitest';
import { pesos } from '../src/domain/money.js';
import { naturalBalance } from '../src/domain/reports.js';
import { taxPosition } from '../src/domain/taxReport.js';
import { invoiceSequenceGaps } from '../src/domain/controls/rules.js';
import { COLOMBIA } from '../src/domain/jurisdictions/colombia.js';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { InvoiceService } from '../src/services/invoiceService.js';
import type { Jurisdiction } from '../src/domain/jurisdiction.js';
import type { Account } from '../src/domain/accounts.js';

/**
 * A second, deliberately synthetic jurisdiction. It exists ONLY to prove the
 * Jurisdiction seam actually changes behavior when swapped — different
 * accounts, a different VAT rate, a different currency, withholding OFF, a
 * different compliance message. It is NOT a real market: do not wire it into
 * FirmWorkspace/server defaults, and do not treat it as a stand-in for the
 * real second jurisdiction (Saudi Arabia), which needs its own real chart,
 * real ZATCA provider, and real research — not this fixture.
 */
const FIXTURE_CHART: readonly Account[] = [
  { code: 'X01', name: 'Test Cash', type: 'activo', normal: 'D' },
  { code: 'X02', name: 'Test Bank', type: 'activo', normal: 'D' },
  { code: 'X03', name: 'Test Receivable', type: 'activo', normal: 'D' },
  { code: 'X04', name: 'Test Input Tax', type: 'activo', normal: 'D' },
  { code: 'X05', name: 'Test Inventory', type: 'activo', normal: 'D' },
  { code: 'X06', name: 'Test Payable', type: 'pasivo', normal: 'C' },
  { code: 'X07', name: 'Test Output Tax', type: 'pasivo', normal: 'C' },
  { code: 'X08', name: 'Test Withholding', type: 'pasivo', normal: 'C' },
  { code: 'X09', name: 'Test Equity', type: 'patrimonio', normal: 'C' },
  { code: 'X10', name: 'Test Revenue', type: 'ingreso', normal: 'C' },
  { code: 'X11', name: 'Test Admin Expense', type: 'gasto', normal: 'D' },
  { code: 'X12', name: 'Test Selling Expense', type: 'gasto', normal: 'D' },
  { code: 'X13', name: 'Test COGS', type: 'costo', normal: 'D' },
];

const FIXTURE: Jurisdiction = {
  id: 'TEST',
  name: 'Test Fixture (not a real market)',
  defaultLocale: 'en',
  chart: FIXTURE_CHART,
  accounts: {
    CASH: 'X01', BANK: 'X02', ACCOUNTS_RECEIVABLE: 'X03', INPUT_VAT: 'X04',
    INVENTORY: 'X05', ACCOUNTS_PAYABLE: 'X06', OUTPUT_VAT: 'X07', WITHHOLDING: 'X08',
    EQUITY: 'X09', REVENUE: 'X10', ADMIN_EXPENSE: 'X11', SELLING_EXPENSE: 'X12', COGS: 'X13',
  },
  currency: {
    code: 'XTS',
    format: (m, withCents = false) => `XTS ${(Number(m) / 100).toFixed(withCents ? 2 : 0)}`,
    toMajorNumber: (m) => Number(m) / 100,
    fromMajorNumber: (n) => BigInt(Math.round(n * 100)),
  },
  tax: { vatStandardBps: 1000, withholding: { enabled: false } },
  invoiceNumberPrefix: 'TST',
  makeProvider: () => COLOMBIA.makeProvider({ clientId: 'x', name: 'x', ofeNit: 'x' }),
  sequenceGapMessage: (code) => `[fixture] missing sequence number ${code}`,
};

describe('Jurisdiction seam', () => {
  it('the fixture jurisdiction resolves balances on its own chart, not Colombia\'s', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, {
      user: 't', approvalThreshold: pesos(1_000_000), jurisdiction: FIXTURE,
    });
    await ledger.post({
      date: '2026-06-10', memo: 'capital', source: 'S', user: 't',
      lines: [{ accountCode: 'X02', debit: pesos(1_000_000) }, { accountCode: 'X09', credit: pesos(1_000_000) }],
    });
    const entries = await repo.listEntries();
    expect(naturalBalance('X02', entries, FIXTURE)).toBe(pesos(1_000_000));
    // Colombia's bank code doesn't exist in the fixture's chart at all.
    expect(() => naturalBalance('111005', entries, FIXTURE)).toThrow();
  });

  it('VAT rate, withholding, invoice prefix, and currency format differ per jurisdiction on the same sale', async () => {
    const issueOne = async (jurisdiction: Jurisdiction) => {
      const repo = new MemoryRepository();
      const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), jurisdiction });
      const provider = jurisdiction.makeProvider({ clientId: 'c1', name: 'Client', ofeNit: '900000000' });
      const invoices = new InvoiceService(repo, ledger, provider, jurisdiction);
      return invoices.issue({
        client: 'Buyer', acquirerId: '1', date: '2026-06-10', concept: 'Sale',
        base: pesos(1_000_000), ofeNit: '900000000',
      });
    };

    const col = await issueOne(COLOMBIA);
    const fix = await issueOne(FIXTURE);

    expect(col.iva).toBe(pesos(190_000)); // 19%
    expect(fix.iva).toBe(pesos(100_000)); // 10%
    expect(col.rete).toBeGreaterThan(0n); // Colombia withholds by default
    expect(fix.rete).toBe(0n);            // fixture has withholding disabled
    expect(col.number.startsWith('FE-')).toBe(true);
    expect(fix.number.startsWith('TST-')).toBe(true);
    expect(COLOMBIA.currency.format(col.total)).toMatch(/^\$/);
    expect(FIXTURE.currency.format(fix.total)).toMatch(/^XTS/);
  });

  it('the invoice sequence-gap compliance message is jurisdiction-specific', () => {
    const colHits = invoiceSequenceGaps(['FE-0001', 'FE-0003'], COLOMBIA);
    const fixHits = invoiceSequenceGaps(['TST-0001', 'TST-0003'], FIXTURE);
    expect(colHits[0]!.message).toContain('DIAN exige numeración continua');
    expect(colHits[0]!.message).toContain('FE-0002');
    expect(fixHits[0]!.message).toBe('[fixture] missing sequence number TST-0002');
  });

  it('taxPosition resolves VAT accounts through the active jurisdiction, not Colombia\'s codes', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), jurisdiction: FIXTURE });
    await ledger.post({
      date: '2026-06-10', memo: 'sale', source: 'S', user: 't',
      lines: [
        { accountCode: 'X02', debit: pesos(1_100_000) },
        { accountCode: 'X10', credit: pesos(1_000_000) },
        { accountCode: 'X07', credit: pesos(100_000) },
      ],
    });
    const entries = await repo.listEntries();
    const tax = taxPosition(entries, FIXTURE);
    expect(tax.ivaGenerado).toBe(pesos(100_000));
  });

  it('a manual cash adjustment is flagged against the jurisdiction\'s own cash/bank accounts', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), jurisdiction: FIXTURE });
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'Ajuste de caja manual', source: 'Ajuste manual', user: 't',
      lines: [{ accountCode: 'X11', debit: pesos(50_000) }, { accountCode: 'X01', credit: pesos(50_000) }],
    });
    expect(findings.some((f) => f.rule === 'Ajuste manual a caja/bancos')).toBe(true);
  });
});
