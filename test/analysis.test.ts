import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { pesos } from '../src/domain/money.js';
import { benfordAnalysis, velocityAnalysis } from '../src/domain/controls/analysis.js';
import { taxPosition } from '../src/domain/taxReport.js';

const clock = () => '2026-06-15T12:00:00.000Z';

describe('population analytics', () => {
  it('velocity flags a source posting many entries the same day', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
    for (let i = 0; i < 4; i++) {
      await ledger.post({
        date: '2026-06-10', memo: `p${i}`, source: 'BurstCo', user: 't',
        lines: [{ accountCode: '1010', debit: pesos(100_000 + i) }, { accountCode: '4000', credit: pesos(100_000 + i) }],
      });
    }
    const hits = velocityAnalysis(await repo.listEntries(), 3);
    expect(hits.some((h) => h.rule === 'Unusual posting velocity')).toBe(true);
  });

  it('benford does not flag small samples, and computes a distribution', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
    await ledger.post({
      date: '2026-06-10', memo: 'x', source: 's', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(123_000) }, { accountCode: '4000', credit: pesos(123_000) }],
    });
    const b = benfordAnalysis(await repo.listEntries());
    expect(b.n).toBe(1);
    expect(b.anomalous).toBe(false); // never flag under 30 samples
    expect(b.expected[0]).toBeCloseTo(0.301, 3);
  });
});

describe('related-party control', () => {
  it('flags a counterparty on the watchlist', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, {
      user: 't', approvalThreshold: pesos(1_000_000), clock,
      relatedParties: ['Inversiones Familiares'],
    });
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'compra', source: 'Inversiones Familiares SAS', user: 't',
      lines: [{ accountCode: '1200', debit: pesos(500_000) }, { accountCode: '1010', credit: pesos(500_000) }],
    });
    expect(findings.some((f) => f.rule === 'Related-party transaction')).toBe(true);
  });
});

describe('DIAN tax position', () => {
  it('computes IVA a pagar = generado - descontable', async () => {
    const repo = new MemoryRepository();
    const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
    // sale: Cr IVA 190,000
    await ledger.post({ date: '2026-06-10', memo: 'venta', source: 'c', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(1_190_000) }, { accountCode: '4000', credit: pesos(1_000_000) }, { accountCode: '2100', credit: pesos(190_000) }] });
    // purchase: Dr IVA descontable 76,000
    await ledger.post({ date: '2026-06-11', memo: 'compra', source: 'p', user: 't',
      lines: [{ accountCode: '1200', debit: pesos(400_000) }, { accountCode: '1150', debit: pesos(76_000) }, { accountCode: '1010', credit: pesos(476_000) }] });
    const tax = taxPosition(await repo.listEntries());
    expect(tax.ivaGenerado).toBe(pesos(190_000));
    expect(tax.ivaDescontable).toBe(pesos(76_000));
    expect(tax.ivaAPagar).toBe(pesos(114_000));
    expect(tax.saldoAFavor).toBe(0n);
  });
});
