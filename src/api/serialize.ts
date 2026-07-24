/**
 * Serializers — convert domain objects (which use bigint centavos) into
 * JSON-safe shapes with peso numbers for the API/UI edge. Money math stays in
 * bigint everywhere else; conversion happens ONLY here, at the boundary.
 */

import { toPesosNumber } from '../domain/money.js';
import { JournalEntry } from '../domain/journal.js';
import { trialBalance, incomeStatement, balanceSheet, cashFlowStatement } from '../domain/reports.js';
import { taxPosition } from '../domain/taxReport.js';

export function serializeEntry(e: JournalEntry) {
  return {
    id: e.id,
    date: e.date,
    memo: e.memo,
    source: e.source,
    user: e.user,
    reversed: e.reversed,
    sourceDocument: e.sourceDocument ?? null,
    amount: toPesosNumber(e.lines.reduce((s, l) => s + l.debit, 0n)),
    lines: e.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: toPesosNumber(l.debit),
      credit: toPesosNumber(l.credit),
    })),
  };
}

export function serializeReports(entries: readonly JournalEntry[]) {
  const tb = trialBalance(entries);
  const is = incomeStatement(entries);
  const bs = balanceSheet(entries);
  const tax = taxPosition(entries);
  const cf = cashFlowStatement(entries);
  return {
    cashFlow: {
      operating: toPesosNumber(cf.operating),
      investing: toPesosNumber(cf.investing),
      financing: toPesosNumber(cf.financing),
      netChange: toPesosNumber(cf.netChange),
      openingCash: toPesosNumber(cf.openingCash),
      closingCash: toPesosNumber(cf.closingCash),
      reconciles: cf.reconciles,
    },
    trialBalance: {
      balanced: tb.balanced,
      totalDebit: toPesosNumber(tb.totalDebit),
      totalCredit: toPesosNumber(tb.totalCredit),
      rows: tb.rows.map((r) => ({
        code: r.code,
        name: r.name,
        debit: toPesosNumber(r.debit),
        credit: toPesosNumber(r.credit),
      })),
    },
    incomeStatement: {
      ingresos: toPesosNumber(is.ingresos),
      costo: toPesosNumber(is.costo),
      gastos: toPesosNumber(is.gastos),
      utilidad: toPesosNumber(is.utilidad),
    },
    balanceSheet: {
      activos: toPesosNumber(bs.activos),
      pasivos: toPesosNumber(bs.pasivos),
      patrimonio: toPesosNumber(bs.patrimonio),
      cuadra: bs.cuadra,
    },
    taxPosition: {
      ivaGenerado: toPesosNumber(tax.ivaGenerado),
      ivaDescontable: toPesosNumber(tax.ivaDescontable),
      ivaAPagar: toPesosNumber(tax.ivaAPagar),
      saldoAFavor: toPesosNumber(tax.saldoAFavor),
      retencionesAFavor: toPesosNumber(tax.retencionesAFavor),
      retencionesPorPagar: toPesosNumber(tax.retencionesPorPagar),
    },
  };
}
