/**
 * Demo seed for the API/UI — a Saudi accounting firm with three clients, each
 * with a month of activity and different risk profiles (one clean, two with
 * planted anomalies). Amounts are in SAR (halalas as minor units).
 */

import { FirmWorkspace } from '../services/firmWorkspace.js';
import { pesos, applyRateBps } from '../domain/money.js';

const VAT = 1500; // KSA 15%

export async function seedFirm(): Promise<FirmWorkspace> {
  const firm = new FirmWorkspace({
    user: 'a.alfaris',
    approvalThreshold: pesos(1_000_000),
    relatedParties: ['Al-Faris Holding', 'Family Investments'],
  });
  await seedInto(firm);
  return firm;
}

/** Populate a firm with the demo clients + a month of activity. Used on first
 *  run (when no persisted data exists); afterwards the saved books load instead. */
export async function seedInto(firm: FirmWorkspace): Promise<void> {
  // --- Client A: elevated risk (anomalies) ---
  {
    const a = firm.addClient({ clientId: 'andina', name: 'Al-Rajhi Trading Co.', ofeNit: '300012345600003' });
    await a.ledger.post({ date: '2026-06-01', memo: 'Capital contribution', source: 'Shareholders', user: 'seed',
      lines: [{ accountCode: '1010', debit: pesos(60_000_000) }, { accountCode: '3000', credit: pesos(60_000_000) }] });
    await a.invoices.issue({ client: 'Danube Markets', acquirerId: '310011122200003', date: '2026-06-05', concept: 'Sale', base: pesos(7_200_000), ofeNit: '300012345600003' });
    await a.invoices.issue({ client: 'Panda Retail', acquirerId: '310033344400003', date: '2026-06-12', concept: 'Sale', base: pesos(12_500_000), ofeNit: '300012345600003' });
    // weekend + round + manual cash adjustment
    await a.ledger.post({ date: '2026-06-13', memo: 'Manual cash adjustment', source: 'Manual adjustment', user: 'seed',
      lines: [{ accountCode: '6000', debit: pesos(2_000_000) }, { accountCode: '1000', credit: pesos(2_000_000) }] });
    // just under threshold
    const base = pesos(950_000), vat = applyRateBps(base, VAT);
    await a.ledger.post({ date: '2026-06-18', memo: 'Consulting services', source: 'Advisory LLC', user: 'seed',
      lines: [{ accountCode: '6100', debit: base }, { accountCode: '1150', debit: vat }, { accountCode: '1010', credit: base + vat }] });
    // duplicate of first Danube sale
    await a.invoices.issue({ client: 'Danube Markets', acquirerId: '310011122200003', date: '2026-06-05', concept: 'Sale (re-entry)', base: pesos(7_200_000), ofeNit: '300012345600003' });
    // related-party
    await a.ledger.post({ date: '2026-06-19', memo: 'Purchase from related party', source: 'Family Investments', user: 'seed',
      lines: [{ accountCode: '1200', debit: pesos(4_000_000) }, { accountCode: '1010', credit: pesos(4_000_000) }] });
  }

  // --- Client B: clean books (low risk) ---
  {
    const b = firm.addClient({ clientId: 'roble', name: 'Jeddah Foods Est.', ofeNit: '300055566600003' });
    await b.ledger.post({ date: '2026-06-01', memo: 'Capital contribution', source: 'Shareholders', user: 'seed',
      lines: [{ accountCode: '1010', debit: pesos(25_000_000) }, { accountCode: '3000', credit: pesos(25_000_000) }] });
    await b.invoices.issue({ client: 'Tamimi Markets', acquirerId: '310077788800003', date: '2026-06-04', concept: 'Service', base: pesos(2_340_000), ofeNit: '300055566600003' });
    await b.invoices.issue({ client: 'Al-Othaim', acquirerId: '310088899900003', date: '2026-06-10', concept: 'Service', base: pesos(3_180_000), ofeNit: '300055566600003' });
    await b.ledger.post({ date: '2026-06-11', memo: 'Office rent', source: 'Landlord', user: 'seed',
      lines: [{ accountCode: '6000', debit: pesos(1_450_000) }, { accountCode: '1010', credit: pesos(1_450_000) }] });
  }

  // --- Client C: medium risk (a couple of flags) ---
  {
    const c = firm.addClient({ clientId: 'esquina', name: 'Riyadh Tech Solutions', ofeNit: '300099988800003' });
    await c.ledger.post({ date: '2026-06-01', memo: 'Capital contribution', source: 'Shareholders', user: 'seed',
      lines: [{ accountCode: '1010', debit: pesos(8_000_000) }, { accountCode: '3000', credit: pesos(8_000_000) }] });
    await c.ledger.post({ date: '2026-06-06', memo: 'Supplies purchase', source: 'Supplier Co', user: 'seed',
      lines: [{ accountCode: '1200', debit: pesos(1_500_000) }, { accountCode: '1010', credit: pesos(1_500_000) }] });
    // round large adjustment
    await c.ledger.post({ date: '2026-06-15', memo: 'Inventory adjustment', source: 'Stock count', user: 'seed',
      lines: [{ accountCode: '5000', debit: pesos(3_000_000) }, { accountCode: '1200', credit: pesos(3_000_000) }] });
  }
}
