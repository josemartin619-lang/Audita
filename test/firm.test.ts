import { describe, it, expect } from 'vitest';
import { FirmWorkspace } from '../src/services/firmWorkspace.js';
import { pesos } from '../src/domain/money.js';

const clock = () => '2026-06-15T12:00:00.000Z';

describe('multi-tenant firm workspace', () => {
  it('isolates each client’s books structurally (no cross-client leakage)', async () => {
    const firm = new FirmWorkspace({ user: 'f', approvalThreshold: pesos(1_000_000), clock });
    const a = firm.addClient({ clientId: 'a', name: 'A', ofeNit: '900' });
    const b = firm.addClient({ clientId: 'b', name: 'B', ofeNit: '901' });
    await a.ledger.post({ date: '2026-06-10', memo: 'A entry', source: 's', user: 'f',
      lines: [{ accountCode: '1010', debit: pesos(1_000_000) }, { accountCode: '3000', credit: pesos(1_000_000) }] });

    expect((await a.repo.listEntries()).length).toBe(1);
    expect((await b.repo.listEntries()).length).toBe(0); // B cannot see A's entry
  });

  it('rejects duplicate client ids', () => {
    const firm = new FirmWorkspace({ user: 'f', approvalThreshold: pesos(1_000_000), clock });
    firm.addClient({ clientId: 'x', name: 'X', ofeNit: '900' });
    expect(() => firm.addClient({ clientId: 'x', name: 'X2', ofeNit: '901' })).toThrow();
  });

  it('console ranks clients by risk (highest first)', async () => {
    const firm = new FirmWorkspace({ user: 'f', approvalThreshold: pesos(1_000_000), clock });
    const risky = firm.addClient({ clientId: 'risky', name: 'Risky', ofeNit: '900' });
    firm.addClient({ clientId: 'clean', name: 'Clean', ofeNit: '901' });
    // create findings on the risky client (weekend + round + duplicate)
    await risky.ledger.post({ date: '2026-06-13', memo: 'Ajuste manual', source: 'Ajuste manual', user: 'f',
      lines: [{ accountCode: '6000', debit: pesos(2_000_000) }, { accountCode: '1000', credit: pesos(2_000_000) }] });
    const rows = await firm.console();
    expect(rows[0]!.clientId).toBe('risky');
    expect(rows[0]!.risk.score).toBeGreaterThan(rows[1]!.risk.score);
  });
});
