/**
 * Demo bootstrap — seeds a realistic month, prints the reports, findings, risk
 * score, and an evidence-ready close package. Run with `npm run demo`.
 *
 * Everything here is the REAL core (same code the tests exercise), wired to the
 * in-memory repository and the sandbox e-invoicing provider.
 */

import { MemoryRepository } from './persistence/memoryRepo.js';
import { LedgerService } from './services/ledgerService.js';
import { InvoiceService } from './services/invoiceService.js';
import { SandboxEInvoicingProvider } from './einvoicing/sandboxProvider.js';
import { pesos, formatCOP, applyRateBps } from './domain/money.js';
import { trialBalance, incomeStatement, balanceSheet } from './domain/reports.js';
import { scoreRisk } from './domain/riskScoring.js';
import { buildWorkingPaper, assembleClosePackage } from './domain/workingPapers.js';
import { naturalBalance } from './domain/reports.js';

const OFE_NIT = '900123456';

async function main() {
  const repo = new MemoryRepository();
  const ledger = new LedgerService(repo, { user: 'j.martin', approvalThreshold: pesos(1_000_000) });
  const invoices = new InvoiceService(repo, ledger, new SandboxEInvoicingProvider());

  // Opening capital
  await ledger.post({
    date: '2026-06-01', memo: 'Aporte inicial de capital', source: 'Socios', user: 'j.martin',
    lines: [{ accountCode: '111005', debit: pesos(60_000_000) }, { accountCode: '310505', credit: pesos(60_000_000) }],
  });

  // Inventory purchase (Dr inventory + Dr IVA descontable, Cr banco)
  {
    const base = pesos(18_000_000), iva = applyRateBps(base, 1900);
    await ledger.post({
      date: '2026-06-03', memo: 'Compra de inventario', source: 'Distribuidora Norte', user: 'j.martin',
      lines: [
        { accountCode: '143505', debit: base },
        { accountCode: '135515', debit: iva },
        { accountCode: '111005', credit: base + iva },
      ],
    });
  }

  // Normal sales
  await invoices.issue({ client: 'Almacenes Vélez', acquirerId: '830111', date: '2026-06-05', concept: 'Venta', base: pesos(7_200_000), ofeNit: OFE_NIT });
  await invoices.issue({ client: 'Ferretería El Tornillo', acquirerId: '830222', date: '2026-06-09', concept: 'Venta', base: pesos(3_400_000), ofeNit: OFE_NIT });
  await invoices.issue({ client: 'Supermercado La 14', acquirerId: '830333', date: '2026-06-12', concept: 'Venta', base: pesos(12_500_000), ofeNit: OFE_NIT });

  // ANOMALY: weekend + round + manual cash adjustment (2026-06-13 is Saturday)
  await ledger.post({
    date: '2026-06-13', memo: 'Ajuste de caja — soporte pendiente', source: 'Ajuste manual', user: 'j.martin',
    lines: [{ accountCode: '513505', debit: pesos(2_000_000) }, { accountCode: '110505', credit: pesos(2_000_000) }],
  });

  await invoices.issue({ client: 'Distrialimentos SAS', acquirerId: '830444', date: '2026-06-16', concept: 'Venta', base: pesos(5_600_000), ofeNit: OFE_NIT });

  // ANOMALY: amount just under approval threshold
  {
    const base = pesos(950_000), iva = applyRateBps(base, 1900);
    await ledger.post({
      date: '2026-06-18', memo: 'Servicios de consultoría', source: 'Asesorías JJ', user: 'j.martin',
      lines: [{ accountCode: '523505', debit: base }, { accountCode: '135515', debit: iva }, { accountCode: '111005', credit: base + iva }],
    });
  }

  // ANOMALY: duplicate of the first Vélez sale (same source, date, amount)
  await invoices.issue({ client: 'Almacenes Vélez', acquirerId: '830111', date: '2026-06-05', concept: 'Venta (re-registro)', base: pesos(7_200_000), ofeNit: OFE_NIT });

  // ANOMALY: skip a consecutive to trigger a sequence gap, then issue
  invoices.skipNumbers(1);
  await invoices.issue({ client: 'Inversiones El Roble', acquirerId: '830555', date: '2026-06-20', concept: 'Venta', base: pesos(4_100_000), ofeNit: OFE_NIT });

  // ---- Reports ----
  const entries = await repo.listEntries();
  const tb = trialBalance(entries);
  const is = incomeStatement(entries);
  const bs = balanceSheet(entries);

  const line = (s: string) => console.log(s);
  line('\n============================================================');
  line('  AUDITA — cierre demostrativo · periodo 2026-06');
  line('============================================================');

  line('\n▚ BALANZA DE COMPROBACIÓN');
  for (const r of tb.rows) {
    line(`  ${r.code}  ${r.name.padEnd(34)}  D ${formatCOP(r.debit).padStart(16)}  C ${formatCOP(r.credit).padStart(16)}`);
  }
  line(`  ${''.padEnd(42)}  ─────────────────────────────────────`);
  line(`  TOTALES${''.padEnd(35)}  D ${formatCOP(tb.totalDebit).padStart(16)}  C ${formatCOP(tb.totalCredit).padStart(16)}`);
  line(`  Cuadra: ${tb.balanced ? '✓ SÍ (débitos = créditos)' : '✗ NO'}`);

  line('\n▚ ESTADO DE RESULTADOS');
  line(`  Ingresos              ${formatCOP(is.ingresos).padStart(16)}`);
  line(`  Costo de ventas      -${formatCOP(is.costo).padStart(16)}`);
  line(`  Gastos               -${formatCOP(is.gastos).padStart(16)}`);
  line(`  Utilidad              ${formatCOP(is.utilidad).padStart(16)}`);

  line('\n▚ BALANCE GENERAL');
  line(`  Activos               ${formatCOP(bs.activos).padStart(16)}`);
  line(`  Pasivos               ${formatCOP(bs.pasivos).padStart(16)}`);
  line(`  Patrimonio            ${formatCOP(bs.patrimonio).padStart(16)}`);
  line(`  A = P + Pat: ${bs.cuadra ? '✓' : '✗'}`);

  // ---- Audit layer ----
  const findings = await repo.listFindings();
  line(`\n🛡️ HALLAZGOS DE CONTROL CONTINUO (${findings.length})`);
  for (const f of findings) {
    line(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.id} ${f.rule} (${f.entryId}) — ${f.message}`);
  }

  const risk = scoreRisk({ findings, entries });
  line(`\n🎯 RIESGO DEL CLIENTE: ${risk.score}/100 (${risk.band.toUpperCase()})`);
  for (const d of risk.drivers) line(`   · ${d}`);

  const trail = ledger.auditTrail();
  const chain = trail.verify();
  line(`\n🔗 RASTRO DE EVIDENCIA: ${trail.all().length} eventos · cadena ${chain.valid ? 'VÁLIDA ✓' : 'ROTA ✗ en #' + chain.brokenAtSeq}`);

  // ---- Working papers + close ----
  const now = '2026-07-01T09:00:00.000Z';
  const wpBank = buildWorkingPaper({
    id: 'WP-111005', accountCode: '111005', period: '2026-06', entries,
    supportBalance: naturalBalance('111005', entries), // ties (certificado bancario matches)
    preparedBy: 'j.martin', notes: 'Conciliado contra certificado bancario.', createdAt: now,
  });
  const wpClients = buildWorkingPaper({
    id: 'WP-130505', accountCode: '130505', period: '2026-06', entries,
    supportBalance: naturalBalance('130505', entries) - pesos(1_000_000), // deliberate untie
    preparedBy: 'j.martin', notes: 'Diferencia por confirmar con cliente.', createdAt: now,
  });
  await repo.saveWorkingPaper(wpBank);
  await repo.saveWorkingPaper(wpClients);

  const openHigh = findings.filter((f) => f.severity === 'high' && (f.status === 'open' || f.status === 'escalated')).length;
  const close = assembleClosePackage({
    period: '2026-06', generatedAt: now,
    trialBalanceBalanced: tb.balanced, auditTrailValid: chain.valid,
    openHighFindings: openHigh, openFindings: findings.filter((f) => f.status === 'open').length,
    workingPapers: [wpBank, wpClients],
  });
  line(`\n📦 PAQUETE DE CIERRE 2026-06 — listo para cerrar: ${close.readyToClose ? 'SÍ ✓' : 'NO ✗'}`);
  for (const b of close.blockers) line(`   ⚠︎ ${b}`);
  line('   (El cierre produce el archivo de auditoría: balanza, papeles de trabajo, hallazgos, firmas.)');
  line('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
