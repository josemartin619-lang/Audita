import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../src/persistence/memoryRepo.js';
import { LedgerService } from '../src/services/ledgerService.js';
import { InvoiceService } from '../src/services/invoiceService.js';
import { SandboxEInvoicingProvider } from '../src/einvoicing/sandboxProvider.js';
import { pesos, applyRateBps } from '../src/domain/money.js';
import { trialBalance } from '../src/domain/reports.js';

const clock = () => '2026-06-15T12:00:00.000Z';

function make() {
  const repo = new MemoryRepository();
  const ledger = new LedgerService(repo, { user: 't', approvalThreshold: pesos(1_000_000), clock });
  const invoices = new InvoiceService(repo, ledger, new SandboxEInvoicingProvider());
  return { repo, ledger, invoices };
}

describe('DIAN e-invoicing (sandbox) + booking', () => {
  it('produces a 96-hex-char CUFE (SHA-384) and VALIDADA status', async () => {
    const { invoices } = make();
    const inv = await invoices.issue({ client: 'Cliente A', acquirerId: '830111', date: '2026-06-10', concept: 'Venta', base: pesos(1_000_000), ofeNit: '900123456' });
    expect(inv.cufe).toMatch(/^[0-9a-f]{96}$/);
    expect(inv.status).toBe('VALIDADA');
  });

  it('is deterministic: same inputs -> same CUFE', async () => {
    const a = make();
    const b = make();
    const i1 = await a.invoices.issue({ client: 'X', acquirerId: '830', date: '2026-06-10', concept: 'V', base: pesos(2_000_000), ofeNit: '900', issueTime: '10:00:00-05:00' });
    const i2 = await b.invoices.issue({ client: 'X', acquirerId: '830', date: '2026-06-10', concept: 'V', base: pesos(2_000_000), ofeNit: '900', issueTime: '10:00:00-05:00' });
    expect(i1.cufe).toBe(i2.cufe);
  });

  it('posts a balanced entry with correct IVA and retefuente', async () => {
    const { repo, invoices } = make();
    const base = pesos(4_000_000);
    const inv = await invoices.issue({ client: 'Cliente B', acquirerId: '830222', date: '2026-06-10', concept: 'Venta', base, ofeNit: '900123456' });
    expect(inv.iva).toBe(applyRateBps(base, 1900));
    expect(inv.rete).toBe(applyRateBps(base, 250));
    expect(inv.total).toBe(base + inv.iva - inv.rete);
    const tb = trialBalance(await repo.listEntries());
    expect(tb.balanced).toBe(true);
  });

  it('raises a finding when a consecutive is skipped', async () => {
    const { repo, invoices } = make();
    await invoices.issue({ client: 'A', acquirerId: '1', date: '2026-06-10', concept: 'V', base: pesos(500_000), ofeNit: '900' });
    invoices.skipNumbers(1); // skip FE-0002
    await invoices.issue({ client: 'B', acquirerId: '2', date: '2026-06-11', concept: 'V', base: pesos(500_000), ofeNit: '900' });
    const findings = await repo.listFindings();
    expect(findings.some((f) => f.rule === 'Salto en consecutivo')).toBe(true);
  });
});
