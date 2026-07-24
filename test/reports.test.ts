import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { pesos } from '../src/domain/money.js';
import { incomeStatement, balanceSheet, trialBalance, naturalBalance, cashFlowStatement } from '../src/domain/reports.js';
import { buildWorkingPaper, assembleClosePackage, isTiedOut } from '../src/domain/workingPapers.js';

const clock = () => '2026-06-15T12:00:00.000Z';

async function seeded() {
  const repo = new MemoryRepository();
  const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
  // capital
  await ledger.post({ date: '2026-06-01', memo: 'capital', source: 'S', user: 't',
    lines: [{ accountCode: '1010', debit: pesos(10_000_000) }, { accountCode: '3000', credit: pesos(10_000_000) }] });
  // a sale: Dr banco 1,190,000 ; Cr ingresos 1,000,000 ; Cr IVA 190,000
  await ledger.post({ date: '2026-06-10', memo: 'venta', source: 'C', user: 't',
    lines: [{ accountCode: '1010', debit: pesos(1_190_000) }, { accountCode: '4000', credit: pesos(1_000_000) }, { accountCode: '2100', credit: pesos(190_000) }] });
  // an expense: Dr gasto 500,000 ; Cr banco 500,000
  await ledger.post({ date: '2026-06-11', memo: 'gasto', source: 'P', user: 't',
    lines: [{ accountCode: '6000', debit: pesos(500_000) }, { accountCode: '1010', credit: pesos(500_000) }] });
  return repo;
}

describe('financial reports', () => {
  it('computes income statement correctly', async () => {
    const entries = await (await seeded()).listEntries();
    const is = incomeStatement(entries);
    expect(is.ingresos).toBe(pesos(1_000_000));
    expect(is.gastos).toBe(pesos(500_000));
    expect(is.utilidad).toBe(pesos(500_000));
  });

  it('balance sheet balances: A = P + Patrimonio', async () => {
    const entries = await (await seeded()).listEntries();
    const bs = balanceSheet(entries);
    // Activos: banco = 10,000,000 + 1,190,000 - 500,000 = 10,690,000
    expect(bs.activos).toBe(pesos(10_690_000));
    // Pasivos: IVA 190,000 ; Patrimonio: capital 10,000,000 + utilidad 500,000
    expect(bs.pasivos).toBe(pesos(190_000));
    expect(bs.patrimonio).toBe(pesos(10_500_000));
    expect(bs.cuadra).toBe(true);
  });

  it('trial balance totals tie', async () => {
    const entries = await (await seeded()).listEntries();
    const tb = trialBalance(entries);
    expect(tb.balanced).toBe(true);
  });

  it('cash-flow statement classifies activities and reconciles to net change in cash', async () => {
    const entries = await (await seeded()).listEntries();
    const cf = cashFlowStatement(entries);
    // seeded(): capital 10,000,000 (financing in), sale banked 1,190,000 (operating), expense 500,000 (operating out)
    expect(cf.financing).toBe(pesos(10_000_000));
    expect(cf.operating).toBe(pesos(1_190_000) - pesos(500_000)); // +690,000 net operating
    expect(cf.investing).toBe(pesos(0));
    // three activities sum to net change, which reconciles to closing cash (opening 0)
    expect(cf.netChange).toBe(cf.operating + cf.financing + cf.investing);
    expect(cf.closingCash).toBe(pesos(10_690_000));
    expect(cf.reconciles).toBe(true);
    expect(cf.openingCash).toBe(pesos(0));
  });
});

describe('working papers + close', () => {
  it('a tied-out working paper has zero difference', async () => {
    const entries = await (await seeded()).listEntries();
    const wp = buildWorkingPaper({
      id: 'WP-1', accountCode: '1010', period: '2026-06', entries,
      supportBalance: naturalBalance('1010', entries), preparedBy: 't', createdAt: clock(),
    });
    expect(isTiedOut(wp)).toBe(true);
  });

  it('blocks the close when a working paper does not tie out', async () => {
    const entries = await (await seeded()).listEntries();
    const untied = buildWorkingPaper({
      id: 'WP-2', accountCode: '1010', period: '2026-06', entries,
      supportBalance: naturalBalance('1010', entries) - pesos(1), preparedBy: 't', createdAt: clock(),
    });
    const pkg = assembleClosePackage({
      period: '2026-06', generatedAt: clock(), trialBalanceBalanced: true, auditTrailValid: true,
      openHighFindings: 0, openFindings: 0, workingPapers: [untied],
    });
    expect(pkg.readyToClose).toBe(false);
    expect(pkg.blockers.some((b) => /working paper/.test(b))).toBe(true);
  });

  it('blocks the close when a high-severity finding is open', async () => {
    const pkg = assembleClosePackage({
      period: '2026-06', generatedAt: clock(), trialBalanceBalanced: true, auditTrailValid: true,
      openHighFindings: 1, openFindings: 1, workingPapers: [],
    });
    expect(pkg.readyToClose).toBe(false);
  });
});
