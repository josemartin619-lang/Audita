import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { pesos } from '../src/domain/money.js';
import { invoiceSequenceGaps } from '../src/domain/controls/rules.js';

const clock = () => '2026-06-15T12:00:00.000Z';
function make() {
  const repo = new MemoryRepository();
  const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
  return { repo, ledger };
}

describe('continuous controls', () => {
  it('flags a weekend posting (2026-06-13 is a Saturday)', async () => {
    const { ledger } = make();
    const { findings } = await ledger.post({
      date: '2026-06-13', memo: 'venta', source: 'X', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(500) }, { accountCode: '4000', credit: pesos(500) }],
    });
    expect(findings.some((f) => f.rule === 'Weekend posting')).toBe(true);
  });

  it('flags an amount just under the approval threshold as high severity', async () => {
    const { ledger } = make();
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'compra', source: 'Y', user: 't',
      lines: [{ accountCode: '6100', debit: pesos(950_000) }, { accountCode: '1010', credit: pesos(950_000) }],
    });
    const f = findings.find((x) => x.rule === 'Amount just under approval threshold');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('flags a large perfectly-round amount', async () => {
    const { ledger } = make();
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'ajuste', source: 'Z', user: 't',
      lines: [{ accountCode: '6000', debit: pesos(5_000_000) }, { accountCode: '1010', credit: pesos(5_000_000) }],
    });
    expect(findings.some((f) => f.rule === 'Unusual round amount')).toBe(true);
  });

  it('flags a duplicate (same source, date, amount)', async () => {
    const { ledger } = make();
    const mk = () => ledger.post({
      date: '2026-06-10', memo: 'venta', source: 'ACME', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(300_000) }, { accountCode: '4000', credit: pesos(300_000) }],
    });
    await mk();
    const second = await mk();
    expect(second.findings.some((f) => f.rule === 'Possible duplicate')).toBe(true);
  });

  it('flags a manual cash adjustment', async () => {
    const { ledger } = make();
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'Ajuste de caja manual', source: 'Ajuste manual', user: 't',
      lines: [{ accountCode: '6000', debit: pesos(120_000) }, { accountCode: '1000', credit: pesos(120_000) }],
    });
    expect(findings.some((f) => f.rule === 'Manual cash/bank adjustment')).toBe(true);
  });

  it('detects invoice consecutive gaps', () => {
    const hits = invoiceSequenceGaps(['FE-0001', 'FE-0002', 'FE-0004']);
    expect(hits.length).toBe(1);
    expect(hits[0]!.message).toContain('FE-0003');
  });

  it('a clean weekday entry produces no findings', async () => {
    const { ledger } = make();
    const { findings } = await ledger.post({
      date: '2026-06-10', memo: 'venta normal', source: 'Cliente A', user: 't',
      lines: [{ accountCode: '1010', debit: pesos(273_450) }, { accountCode: '4000', credit: pesos(273_450) }],
    });
    expect(findings.length).toBe(0);
  });
});
