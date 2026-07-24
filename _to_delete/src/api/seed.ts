/**
 * Demo seed for the API/UI — a firm with three clients, each with a month of
 * activity and different risk profiles (one clean, two with planted anomalies).
 */

import { FirmWorkspace } from '../services/firmWorkspace.js';
import { pesos, applyRateBps } from '../domain/money.js';

export async function seedFirm(): Promise<FirmWorkspace> {
  const firm = new FirmWorkspace({
    user: 'j.martin',
    approvalThreshold: pesos(1_000_000),
    relatedParties: ['Inversiones Familiares', 'Martin Holding'],
  });

  // --- Client A: elevated risk (anomalies) ---
  {
    const a = firm.addClient({ clientId: 'andina', name: 'Comercializadora Andina S.A.S.', ofeNit: '900123456' });
    await a.ledger.post({ date: '2026-06-01', memo: 'Aporte de capital', source: 'Socios', user: 'seed',
      lines: [{ accountCode: '111005', debit: pesos(60_000_000) }, { accountCode: '310505', credit: pesos(60_000_000) }] });
    await a.invoices.issue({ client: 'Almacenes Vélez', acquirerId: '830111', date: '2026-06-05', concept: 'Venta', base: pesos(7_200_000), ofeNit: '900123456' });
    await a.invoices.issue({ client: 'Supermercado La 14', acquirerId: '830333', date: '2026-06-12', concept: 'Venta', base: pesos(12_500_000), ofeNit: '900123456' });
    // weekend + round + manual cash adjustment
    await a.ledger.post({ date: '2026-06-13', memo: 'Ajuste de caja manual', source: 'Ajuste manual', user: 'seed',
      lines: [{ accountCode: '513505', debit: pesos(2_000_000) }, { accountCode: '110505', credit: pesos(2_000_000) }] });
    // just under threshold
    const base = pesos(950_000), iva = applyRateBps(base, 1900);
    await a.ledger.post({ date: '2026-06-18', memo: 'Servicios de consultoría', source: 'Asesorías JJ', user: 'seed',
      lines: [{ accountCode: '523505', debit: base }, { accountCode: '135515', debit: iva }, { accountCode: '111005', credit: base + iva }] });
    // duplicate of first Vélez sale
    await a.invoices.issue({ client: 'Almacenes Vélez', acquirerId: '830111', date: '2026-06-05', concept: 'Venta (re-registro)', base: pesos(7_200_000), ofeNit: '900123456' });
    // related-party
    await a.ledger.post({ date: '2026-06-19', memo: 'Compra a vinculada', source: 'Inversiones Familiares', user: 'seed',
      lines: [{ accountCode: '143505', debit: pesos(4_000_000) }, { accountCode: '111005', credit: pesos(4_000_000) }] });
  }

  // --- Client B: clean books (low risk) ---
  {
    const b = firm.addClient({ clientId: 'roble', name: 'Inversiones El Roble Ltda.', ofeNit: '901222333' });
    await b.ledger.post({ date: '2026-06-01', memo: 'Aporte de capital', source: 'Socios', user: 'seed',
      lines: [{ accountCode: '111005', debit: pesos(25_000_000) }, { accountCode: '310505', credit: pesos(25_000_000) }] });
    await b.invoices.issue({ client: 'Cliente Norte', acquirerId: '830777', date: '2026-06-04', concept: 'Servicio', base: pesos(2_340_000), ofeNit: '901222333' });
    await b.invoices.issue({ client: 'Cliente Sur', acquirerId: '830888', date: '2026-06-10', concept: 'Servicio', base: pesos(3_180_000), ofeNit: '901222333' });
    await b.ledger.post({ date: '2026-06-11', memo: 'Arriendo oficina', source: 'Inmobiliaria', user: 'seed',
      lines: [{ accountCode: '513505', debit: pesos(1_450_000) }, { accountCode: '111005', credit: pesos(1_450_000) }] });
  }

  // --- Client C: medium risk (a couple of flags) ---
  {
    const c = firm.addClient({ clientId: 'esquina', name: 'Cafetería La Esquina S.A.S.', ofeNit: '901444555' });
    await c.ledger.post({ date: '2026-06-01', memo: 'Aporte de capital', source: 'Socios', user: 'seed',
      lines: [{ accountCode: '111005', debit: pesos(8_000_000) }, { accountCode: '310505', credit: pesos(8_000_000) }] });
    await c.ledger.post({ date: '2026-06-06', memo: 'Compra insumos', source: 'Proveedor Café', user: 'seed',
      lines: [{ accountCode: '143505', debit: pesos(1_500_000) }, { accountCode: '111005', credit: pesos(1_500_000) }] });
    // round large adjustment
    await c.ledger.post({ date: '2026-06-15', memo: 'Ajuste inventario', source: 'Conteo físico', user: 'seed',
      lines: [{ accountCode: '613505', debit: pesos(3_000_000) }, { accountCode: '143505', credit: pesos(3_000_000) }] });
  }

  return firm;
}
